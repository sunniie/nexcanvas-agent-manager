import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const HOME = os.homedir();
export const APP_DIR = path.join(HOME, '.nexcanvas');
export const PROFILES_DIR = path.join(APP_DIR, 'profiles');
export const APP_CONFIG = path.join(APP_DIR, 'config.json');

fs.mkdirSync(PROFILES_DIR, { recursive: true });

export const DEFAULT_CLAUDE_DIR = path.join(HOME, '.claude');
export const DEFAULT_CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');

/** Claude keeps `.claude.json` in $HOME for the default profile, inside the config dir otherwise. */
export function claudeStatePath(configDir: string) {
  return configDir ? path.join(configDir, '.claude.json') : path.join(HOME, '.claude.json');
}

export function readJson<T = any>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const binCache = new Map<string, string>();

/** Resolve a CLI to a real executable so we can spawn without a shell (no quoting issues). */
export function resolveBin(name: string): string {
  if (binCache.has(name)) return binCache.get(name)!;
  let found = name;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (process.platform === 'win32') {
      found = out.find((p) => p.toLowerCase().endsWith('.exe')) || out[0] || name;
    } else {
      found = out[0] || name;
    }
  } catch {
    /* not installed */
  }
  binCache.set(name, found);
  return found;
}

export function binExists(name: string) {
  const p = resolveBin(name);
  return p !== name || fs.existsSync(p);
}
