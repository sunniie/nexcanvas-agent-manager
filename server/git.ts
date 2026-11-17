// Git worktree isolation: each employee works on its own branch in its own folder,
// approved work is merged back into the project's current branch by the server.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './paths.ts';

const FALLBACK_IDENTITY = ['-c', 'user.name=NexCanvas Office', '-c', 'user.email=office@nexcanvas.local'];

function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return { ok: true, out: out.trim() };
  } catch (e: any) {
    if (!opts.allowFail) console.warn(`[git] ${args.join(' ')} failed: ${String(e.stderr || e.message).slice(0, 300)}`);
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/** Use the repo's identity if configured, otherwise a neutral office identity. */
function identity(cwd: string): string[] {
  return git(cwd, ['config', 'user.email'], { allowFail: true }).out ? [] : FALLBACK_IDENTITY;
}

export function isGitRepo(dir: string) {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).out === 'true' && hasCommit(dir);
}

function hasCommit(dir: string) {
  return git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).ok;
}

export function currentBranch(dir: string) {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).out || 'HEAD';
}

export function worktreeRoot(projectDir: string) {
  const hash = crypto.createHash('sha1').update(path.resolve(projectDir).toLowerCase()).digest('hex').slice(0, 10);
  return path.join(APP_DIR, 'worktrees', `${path.basename(projectDir)}-${hash}`);
}

export function branchFor(employeeId: string, name: string) {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
  return `office/${slug || 'agent'}-${employeeId.slice(-4)}`;
}

/** Create (or reuse) the employee's worktree. Returns its path. */
export function ensureWorktree(projectDir: string, employeeId: string, branch: string): string {
  const wt = path.join(worktreeRoot(projectDir), employeeId);
  if (fs.existsSync(path.join(wt, '.git'))) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(projectDir, ['worktree', 'prune'], { allowFail: true });
  const exists = git(projectDir, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true }).ok;
  const r = exists
    ? git(projectDir, ['worktree', 'add', wt, branch])
    : git(projectDir, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
  if (!r.ok) throw new Error(`Không tạo được worktree: ${r.out.slice(0, 200)}`);
  return wt;
}

export function removeWorktree(projectDir: string, wt: string) {
  git(projectDir, ['worktree', 'remove', '--force', wt], { allowFail: true });
}

function conflictedFiles(cwd: string) {
  return git(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.split('\n').filter(Boolean);
}

/** Commit everything in the worktree (no-op when clean). */
export function commitAll(wt: string, message: string): boolean {
  git(wt, ['add', '-A']);
  if (git(wt, ['diff', '--cached', '--quiet'], { allowFail: true }).ok) {
    // nothing staged — but a pending merge (conflicts resolved) still needs its commit
    if (!fs.existsSync(path.join(gitDir(wt), 'MERGE_HEAD'))) return false;
  }
  return git(wt, [...identity(wt), 'commit', '--no-verify', '-m', message]).ok;
}

function gitDir(wt: string) {
  const d = git(wt, ['rev-parse', '--git-dir'], { allowFail: true }).out;
  return path.isAbsolute(d) ? d : path.join(wt, d);
}

/**
 * Bring teammates' merged work into the employee's branch before a new task.
 * Leaves conflict markers in place (and returns the files) so the employee can resolve them.
 */
export function syncFromMain(projectDir: string, wt: string): { conflicts: string[] } {
  const main = currentBranch(projectDir);
  if (fs.existsSync(path.join(gitDir(wt), 'MERGE_HEAD'))) return { conflicts: conflictedFiles(wt) };
  commitAll(wt, 'office: wip');
  const r = git(wt, [...identity(wt), 'merge', '--no-edit', main], { allowFail: true });
  return { conflicts: r.ok ? [] : conflictedFiles(wt) };
}

/** Staged diff of the employee's work for the reviewer (inline = no extra tool calls for the coordinator). */
export function reviewDiff(wt: string, maxChars = 12000): { stat: string; patch: string } {
  git(wt, ['add', '-A']);
  const stat = git(wt, ['diff', '--cached', '--stat', 'HEAD'], { allowFail: true }).out;
  let patch = git(wt, ['diff', '--cached', 'HEAD'], { allowFail: true }).out;
  if (patch.length > maxChars) patch = patch.slice(0, maxChars) + `\n… (cắt bớt, xem đầy đủ: git -C "${wt}" diff --cached)`;
  return { stat, patch };
}

/** Diff in a shared (non-worktree) project — includes untracked files via `--stat` of status. */
export function sharedDiffStat(projectDir: string): string {
  const stat = git(projectDir, ['diff', '--stat', 'HEAD'], { allowFail: true }).out;
  const untracked = git(projectDir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true }).out;
  return [stat, untracked && `File mới:\n${untracked}`].filter(Boolean).join('\n');
}

export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[]; error?: string };

/** Commit the approved work on the employee branch and merge it into the project's current branch. */
export function mergeIntoMain(projectDir: string, wt: string, branch: string, message: string): MergeResult {
  commitAll(wt, message);
  const ahead = git(projectDir, ['rev-list', '--count', `HEAD..${branch}`], { allowFail: true }).out;
  if (ahead === '0') return { ok: true, commit: git(projectDir, ['rev-parse', '--short', 'HEAD']).out };
  const r = git(projectDir, [...identity(projectDir), 'merge', '--no-ff', '--no-edit', '-m', `office: ${message}`, branch], { allowFail: true });
  if (r.ok) return { ok: true, commit: git(projectDir, ['rev-parse', '--short', 'HEAD']).out };
  const conflicts = conflictedFiles(projectDir);
  git(projectDir, ['merge', '--abort'], { allowFail: true });
  if (conflicts.length) {
    // Replay the conflict inside the employee's worktree so they can fix it there.
    const sync = syncFromMain(projectDir, wt);
    return { ok: false, conflicts: sync.conflicts.length ? sync.conflicts : conflicts };
  }
  return { ok: false, conflicts: [], error: r.out.slice(0, 400) };
}
