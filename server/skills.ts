import fs from 'node:fs';
import path from 'node:path';
import type { Provider, SkillInfo } from '../shared/types.ts';
import { DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR } from './paths.ts';

/** Only the YAML frontmatter is read — never the skill body — so scanning costs zero model tokens. */
function readFrontmatter(file: string): { name?: string; description?: string } {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch {
    return {};
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return {};
  const get = (k: string) => {
    const r = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1])?.[1]?.trim();
    return r?.replace(/^["']|["']$/g, '');
  };
  return { name: get('name'), description: get('description') };
}

function findSkillFiles(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'SKILL.md') out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function scanSkills(projectDir?: string): SkillInfo[] {
  const sources: { root: string; provider: Provider; depth: number; label: string }[] = [
    { root: path.join(DEFAULT_CLAUDE_DIR, 'skills'), provider: 'claude', depth: 2, label: 'claude:user' },
    { root: path.join(DEFAULT_CLAUDE_DIR, 'plugins'), provider: 'claude', depth: 8, label: 'claude:plugin' },
    { root: path.join(DEFAULT_CODEX_DIR, 'skills'), provider: 'codex', depth: 2, label: 'codex:user' },
    { root: path.join(DEFAULT_CODEX_DIR, 'plugins'), provider: 'codex', depth: 8, label: 'codex:plugin' },
  ];
  if (projectDir) {
    sources.push({ root: path.join(projectDir, '.claude', 'skills'), provider: 'claude', depth: 2, label: 'project' });
    sources.push({ root: path.join(projectDir, '.codex', 'skills'), provider: 'codex', depth: 2, label: 'project' });
  }
  const byName = new Map<string, SkillInfo>();
  for (const s of sources) {
    for (const file of findSkillFiles(s.root, s.depth)) {
      const fm = readFrontmatter(file);
      const name = fm.name || path.basename(path.dirname(file));
      if (!fm.description) continue;
      const prev = byName.get(name);
      if (prev) {
        if (prev.provider !== s.provider) prev.provider = 'both';
        continue;
      }
      byName.set(name, { name, description: fm.description, provider: s.provider, source: s.label });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Compact catalog line per skill for the coordinator prompt (~25 tokens each). */
export function skillCatalog(skills: SkillInfo[], max = 300): string {
  // One short line per skill (~20 tokens) — the whole catalog is read once, during analysis only.
  return skills
    .slice(0, max)
    .map((s) => `- ${s.name} [${s.provider}]: ${s.description.replace(/\s+/g, ' ').slice(0, 70)}`)
    .join('\n');
}
