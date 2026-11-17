import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PICK_PS1 = fileURLToPath(new URL('./assets/pick-folder.ps1', import.meta.url));
let pending: ChildProcess | undefined;

/** Native "choose folder" dialog. Resolves undefined when cancelled, unavailable, or after 5 minutes. */
export function pickFolder(title = 'Select a project folder'): Promise<string | undefined> {
  // Only one dialog at a time; a new request replaces a forgotten one.
  pending?.kill();
  return new Promise((resolve) => {
    const done = (err: unknown, out: string) => {
      pending = undefined;
      const p = (out || '').trim().split(/\r?\n/).pop()?.trim();
      resolve(!err && p ? p : undefined);
    };
    const opts = { timeout: 5 * 60_000, windowsHide: true, encoding: 'utf8' as const };
    if (process.platform === 'win32') {
      pending = execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PICK_PS1, '-Title', title], opts, (e, o) => done(e, o));
    } else if (process.platform === 'darwin') {
      pending = execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${title.replace(/"/g, '')}")`], opts, (e, o) => done(e, o));
    } else {
      pending = execFile('zenity', ['--file-selection', '--directory', `--title=${title}`], opts, (e, o) => done(e, o));
    }
  });
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: { name: string; git: boolean }[];
  roots: { label: string; path: string }[];
}

/** In-app folder browser (works everywhere, including when no native dialog can be shown). */
export function listDir(dir?: string): DirListing {
  const home = os.homedir();
  const target = path.resolve(dir || home);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules')
    .map((e) => ({ name: e.name, git: fs.existsSync(path.join(target, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roots: { label: string; path: string }[] = [{ label: '~', path: home }];
  for (const sub of ['Desktop', 'Documents', 'Downloads']) {
    const p = path.join(home, sub);
    if (fs.existsSync(p)) roots.push({ label: sub, path: p });
  }
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJ') {
      if (fs.existsSync(`${l}:\\`)) roots.push({ label: `${l}:`, path: `${l}:\\` });
    }
  } else {
    roots.push({ label: '/', path: '/' });
  }
  const parent = path.dirname(target);
  return { path: target, parent: parent !== target ? parent : undefined, dirs, roots };
}
