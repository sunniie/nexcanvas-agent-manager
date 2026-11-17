import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  Account,
  Capability,
  Employee,
  Job,
  JobKind,
  LogEntry,
  OfficeState,
  Proposal,
  Provider,
  Task,
  TaskReport,
} from '../shared/types.ts';
import { getAccount, getAccounts, listModels, pickModel, setCooling, updateAccountUsage } from './accounts.ts';
import { APP_CONFIG, APP_DIR, readJson, writeJson } from './paths.ts';
import * as P from './prompts.ts';
import { runClaude } from './runner/claude.ts';
import { runCodex } from './runner/codex.ts';
import type { TurnResult } from './runner/types.ts';
import { scanSkills, skillCatalog } from './skills.ts';
import * as G from './git.ts';

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
export const template: P.OfficeTemplate = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'code.json'), 'utf8'));

const NAMES = ['Bin', 'Na', 'Tí', 'Su', 'Kem', 'Mít', 'Bơ', 'Cốm', 'Gạo', 'Mochi'];
const SKINS = ['#f5d0a9', '#e8b88a', '#c68e5a', '#8d5a3b', '#f9dcc4'];
const HAIRS = ['#2b1d16', '#5a3825', '#c9a227', '#1d1d2b', '#a33b2e', '#6b6b7b', '#e6e1d6'];
const SHIRTS = ['#e85d4a', '#4a90e2', '#50b36b', '#9b59d0', '#f2a93b', '#2fb6a8', '#e45f9b', '#5c6bc0'];
const PANTS = ['#2f3542', '#3b4a6b', '#4b3b2f', '#22313f'];

/** Called whenever state changes so the server can push a snapshot to the UI. */
let notify: () => void = () => {};
let bubble: (employeeId: string, text: string) => void = () => {};
export function onChange(fn: () => void) {
  notify = fn;
}
export function onBubble(fn: (id: string, text: string) => void) {
  bubble = fn;
}

function freshState(): OfficeState {
  return {
    version: 1,
    template: template.id,
    phase: 'choose-coordinator',
    contextFiles: [],
    employees: [],
    tasks: [],
    jobs: [],
    granted: [],
    settings: { leanMode: true, maxParallel: 3, rotateAtTokens: 150_000, maxRevisions: 2, isolation: 'auto', failover: 'off' },
    log: [],
  };
}

export let state: OfficeState = freshState();
let simulatedLimit = false;
const running = new Map<string, { job: Job; abort: AbortController; activity: string }>();

// ---------- persistence ----------

const officeDir = () => (state.projectDir ? path.join(state.projectDir, '.office') : APP_DIR);
const stateFile = () => path.join(officeDir(), state.projectDir ? 'state.json' : 'pending-office.json');

let saveTimer: NodeJS.Timeout | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(stateFile(), state), 200);
  notify();
}

export function loadLast() {
  const cfg = readJson<{ lastProject?: string }>(APP_CONFIG, {});
  const file = cfg.lastProject ? path.join(cfg.lastProject, '.office', 'state.json') : path.join(APP_DIR, 'pending-office.json');
  const loaded = readJson<OfficeState | null>(file, null);
  if (loaded?.version === 1) {
    state = { ...freshState(), ...loaded, settings: { ...freshState().settings, ...loaded.settings } };
    refreshGitInfo();
    // Anything that was mid-flight when the app closed gets re-queued (sessions are resumed, so no work is lost).
    for (const j of state.jobs) if (j.status === 'running') j.status = 'queued';
    for (const e of allStaff()) if (e.status === 'working' || e.status === 'walking-in') e.status = 'idle';
  }
}

function rememberProject(dir: string) {
  const cfg = readJson<Record<string, any>>(APP_CONFIG, {});
  const recent = [dir, ...((cfg.recentProjects as string[]) ?? []).filter((p) => p !== dir)].slice(0, 8);
  writeJson(APP_CONFIG, { ...cfg, lastProject: dir, recentProjects: recent });
}

export function recentProjects(): string[] {
  return readJson<{ recentProjects?: string[] }>(APP_CONFIG, {}).recentProjects ?? [];
}

// ---------- helpers ----------

function refreshGitInfo() {
  if (!state.projectDir) return;
  state.gitRepo = G.isGitRepo(state.projectDir);
  state.mainBranch = state.gitRepo ? G.currentBranch(state.projectDir) : undefined;
}

function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
  return d.split(path.sep).join('/');
}

function useWorktrees() {
  if (!state.projectDir || !state.gitRepo) return false;
  const iso = state.settings.isolation;
  return iso === 'worktree' || (iso === 'auto' && state.employees.length > 1);
}

/**
 * Where an employee works. With isolation, each one gets a git worktree on its own branch so
 * parallel edits never collide; the server merges approved work back into the main branch.
 */
function workdirFor(e: Employee): string {
  if (e.isCoordinator || !useWorktrees()) return state.projectDir!;
  e.branch ??= G.branchFor(e.id, e.name);
  return G.ensureWorktree(state.projectDir!, e.id, e.branch);
}

export function log(who: string, kind: LogEntry['kind'], text: string) {
  state.log.push({ at: Date.now(), who, kind, text });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

export function allStaff(): Employee[] {
  return state.coordinator ? [state.coordinator, ...state.employees] : [...state.employees];
}

function staff(id: string) {
  return allStaff().find((e) => e.id === id);
}

const pick = <T,>(arr: T[], i: number) => arr[Math.abs(i) % arr.length];

function newLook(seed: number): Employee['look'] {
  return { skin: pick(SKINS, seed * 3), hair: pick(HAIRS, seed * 5 + 1), shirt: pick(SHIRTS, seed * 7 + 2), pants: pick(PANTS, seed), hairStyle: seed % 4 };
}

function roleDuty(roleKey: string) {
  return template.roles.find((r) => r.key === roleKey)?.duty ?? 'Làm các task được giao trong chuyên môn của mình.';
}

function ensureOfficeFolder(dir: string) {
  const od = path.join(dir, '.office');
  for (const sub of ['context', 'agents', 'reports']) fs.mkdirSync(path.join(od, sub), { recursive: true });
  // Keep the office out of the user's git history without touching their .gitignore.
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  try {
    if (fs.existsSync(path.dirname(exclude))) {
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.office/')) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.office/\n`);
    }
  } catch {
    /* not a git repo */
  }
}

// ---------- setup flow ----------

export function chooseCoordinator(opts: { provider: Provider; accountId: string; model?: string; effort?: string }) {
  const acc = getAccount(opts.accountId);
  if (!acc || acc.provider !== opts.provider) throw new Error('Tài khoản không hợp lệ');
  const model = opts.model || pickModel(opts.provider, 'high').id;
  state.coordinator = {
    id: 'lead',
    name: 'Trưởng phòng',
    roleKey: 'coordinator',
    title: 'Điều phối',
    isCoordinator: true,
    provider: opts.provider,
    accountId: acc.id,
    model,
    effort: opts.effort || 'high',
    skills: [],
    sessionGeneration: 0,
    status: 'idle',
    desk: -1,
    look: { skin: '#f5d0a9', hair: '#2b1d16', shirt: '#d9534f', pants: '#2f3542', hairStyle: 1 },
    stats: { turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, contextTokens: 0 },
  };
  state.phase = state.projectDir ? 'context' : 'choose-folder';
  log('Trưởng phòng', 'speech', `Chào sếp! Tôi là trưởng phòng (${acc.label}, ${model}). Sếp muốn làm việc trên thư mục nào?`);
  save();
}

export function chooseFolder(dir: string) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('Thư mục không tồn tại');
  const existing = readJson<OfficeState | null>(path.join(abs, '.office', 'state.json'), null);
  if (existing?.version === 1 && existing.coordinator) {
    // Re-open an office that already exists for this project.
    state = { ...freshState(), ...existing, settings: { ...freshState().settings, ...existing.settings } };
    refreshGitInfo();
    rememberProject(abs);
    log('Hệ thống', 'system', `Mở lại văn phòng của ${abs}`);
    save();
    return;
  }
  const prevFile = stateFile();
  state.projectDir = abs;
  refreshGitInfo();
  ensureOfficeFolder(abs);
  rememberProject(abs);
  if (prevFile.endsWith('pending-office.json')) fs.rm(prevFile, () => {});
  state.phase = 'context';
  log('Trưởng phòng', 'speech', 'Sếp có tài liệu nào đi kèm dự án không? (lịch sử chat cũ, file .txt…) Không có cũng được.');
  save();
}

export function addContextFile(name: string, content: string) {
  if (!state.projectDir) throw new Error('Chưa chọn thư mục');
  const safe = name.replace(/[^\w.\-À-ỹ ]+/g, '_').replace(/\.txt$/i, '') + '.txt';
  fs.writeFileSync(path.join(state.projectDir, '.office', 'context', safe), content);
  if (!state.contextFiles.includes(safe)) state.contextFiles.push(safe);
  log('Hệ thống', 'system', `Đã thêm tài liệu ${safe} (${Math.round(content.length / 1000)}k ký tự)`);
  save();
}

export function removeContextFile(name: string) {
  state.contextFiles = state.contextFiles.filter((f) => f !== name);
  if (state.projectDir) fs.rm(path.join(state.projectDir, '.office', 'context', name), () => {});
  save();
}

export function startAnalysis(feedback?: string) {
  if (!state.coordinator || !state.projectDir) throw new Error('Chưa sẵn sàng');
  state.phase = 'analyzing';
  const skills = scanSkills(state.projectDir);
  enqueue('analyze', 'lead', P.analyzePrompt({ template, contextFiles: state.contextFiles, skillCatalog: skillCatalog(skills), feedback }));
  log('Trưởng phòng', 'speech', feedback ? 'Đã nhận góp ý, tôi điều chỉnh lại đề xuất…' : 'Để tôi ngồi vào bàn đọc dự án đã nhé…');
  save();
}

/** Account must exist and match the provider; model must be one that provider offers. */
function validateAssignment(provider: Provider, accountId: string, model: string) {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(`Không có tài khoản ${accountId}`);
  if (acc.provider !== provider) throw new Error(`Tài khoản ${acc.label} là ${acc.provider}, không phải ${provider}`);
  const models = listModels()[provider];
  if (!models.some((m) => m.id === model)) throw new Error(`Model "${model}" không thuộc ${provider}`);
}

export function acceptProposal() {
  if (!state.proposal) throw new Error('Chưa có đề xuất');
  state.phase = 'staffing';
  save();
}

/** Re-open setup to add more staff later (office keeps running). */
export function openStaffing() {
  if (!state.proposal) state.proposal = { summary: '', team: [], risks: [] };
  state.phase = 'staffing';
  save();
}

export interface HireSpec {
  roleKey: string;
  title: string;
  provider: Provider;
  accountId: string;
  model: string;
  effort: string;
  skills: string[];
  name?: string;
}

/** Suggest provider/account/model for each proposed role, spreading load across accounts. */
export function suggestStaffing(): HireSpec[] {
  const accs = getAccounts().filter((a) => a.loggedIn);
  if (!state.proposal || !accs.length) return [];
  // Prefer accounts with headroom in BOTH windows; a nearly exhausted weekly quota is a strong no.
  const load = new Map<string, number>(
    accs.map((a) => {
      const five = a.usage?.fiveHour?.usedPercent ?? 0;
      const week = a.usage?.weekly?.usedPercent ?? 0;
      return [a.id, Math.max(five, week) / 25 + (week >= 85 ? 10 : 0) + (a.coolingUntil && a.coolingUntil > Date.now() ? 20 : 0)];
    }),
  );
  if (state.coordinator) load.set(state.coordinator.accountId, (load.get(state.coordinator.accountId) ?? 0) + 1);
  return state.proposal.team.map((r) => {
    const acc = [...accs].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
    load.set(acc.id, (load.get(acc.id) ?? 0) + 1);
    const model = pickModel(acc.provider, r.modelTier);
    return { roleKey: r.roleKey, title: r.title, provider: acc.provider, accountId: acc.id, model: model.id, effort: r.modelTier === 'high' ? 'high' : 'medium', skills: r.skills };
  });
}

export function hire(specs: HireSpec[]) {
  if (specs.length + state.employees.length > template.maxEmployees) throw new Error(`Tối đa ${template.maxEmployees} nhân viên`);
  for (const s of specs) validateAssignment(s.provider, s.accountId, s.model);
  const used = new Set(state.employees.map((e) => e.desk));
  for (const s of specs) {
    const desk = [0, 1, 2, 3, 4, 5].find((d) => !used.has(d))!;
    used.add(desk);
    const seed = state.employees.length + desk + 1;
    const name = s.name || NAMES.find((n) => !state.employees.some((e) => e.name === n)) || `NV${seed}`;
    state.employees.push({
      id: `e${Date.now().toString(36)}${desk}`,
      name,
      roleKey: s.roleKey,
      title: s.title,
      isCoordinator: false,
      provider: s.provider,
      accountId: s.accountId,
      model: s.model,
      effort: s.effort,
      skills: s.skills,
      sessionGeneration: 0,
      status: 'walking-in',
      desk,
      look: newLook(seed * 13 + desk),
      stats: { turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, contextTokens: 0 },
    });
    log(name, 'speech', `Xin chào! Tôi là ${name}, ${s.title}.`);
  }
  state.phase = 'ready';
  save();
  setTimeout(() => {
    for (const e of state.employees) if (e.status === 'walking-in') e.status = 'idle';
    save();
  }, 6000);
}

export function updateEmployee(id: string, patch: Partial<Pick<Employee, 'name' | 'title' | 'provider' | 'accountId' | 'model' | 'effort' | 'skills'>>) {
  const e = staff(id);
  if (!e) throw new Error('Không tìm thấy nhân viên');
  if (running.has(id)) throw new Error('Nhân viên đang làm việc, đợi xong task rồi đổi cấu hình');
  validateAssignment(patch.provider ?? e.provider, patch.accountId ?? e.accountId, patch.model ?? e.model);
  const providerChanged = patch.provider && patch.provider !== e.provider;
  const accountChanged = patch.accountId && patch.accountId !== e.accountId;
  Object.assign(e, patch);
  if (providerChanged || accountChanged) {
    // A session lives inside one account's config dir, so switching account starts a new one;
    // the employee's notes file carries the memory across.
    e.sessionId = undefined;
    e.sessionGeneration++;
    e.stats.contextTokens = 0;
    // Work parked for quota on the old account can start right away on the new one.
    if (!accountBlockedUntil(getAccount(e.accountId))) {
      for (const j of state.jobs) {
        if (j.employeeId === e.id && j.status === 'waiting_quota') {
          j.status = 'queued';
          j.resumeAt = undefined;
        }
      }
      if (e.status === 'sleeping') {
        e.status = 'idle';
        e.statusText = undefined;
      }
    }
    setImmediate(tick);
  }
  log('Hệ thống', 'system', `Cập nhật ${e.name}: ${Object.keys(patch).join(', ')}`);
  save();
}

export function fire(id: string) {
  if (running.has(id)) throw new Error('Nhân viên đang làm việc');
  const leaving = state.employees.find((e) => e.id === id);
  if (leaving?.workdir && state.projectDir && leaving.workdir !== state.projectDir) G.removeWorktree(state.projectDir, leaving.workdir);
  state.employees = state.employees.filter((e) => e.id !== id);
  state.jobs = state.jobs.filter((j) => j.employeeId !== id || j.status === 'done');
  save();
}

export function resetSession(id: string) {
  const e = staff(id);
  if (!e) return;
  e.sessionId = undefined;
  e.sessionGeneration++;
  e.stats.contextTokens = 0;
  save();
}

// ---------- user ↔ coordinator ----------

export function sendToCoordinator(message: string) {
  if (!state.coordinator) throw new Error('Chưa có trưởng phòng');
  log('Sếp', 'user', message);
  state.goal = message;
  state.goalSummarized = false;
  enqueue('plan', 'lead', P.planPrompt(message, state.employees, state.tasks));
  save();
}

export function grant(caps: Capability[], approvePending = true) {
  state.granted = [...new Set([...state.granted, ...caps])];
  if (approvePending && state.pendingPermission) {
    const t = state.tasks.find((x) => x.id === state.pendingPermission!.taskId);
    if (t && t.status === 'needs_permission') t.status = 'todo';
    state.pendingPermission = undefined;
  }
  log('Sếp', 'user', `Cấp quyền: ${caps.join(', ')}`);
  save();
  tick();
}

export function revoke(cap: Capability) {
  state.granted = state.granted.filter((c) => c !== cap);
  save();
}

export function denyPending() {
  if (!state.pendingPermission) return;
  const t = state.tasks.find((x) => x.id === state.pendingPermission!.taskId);
  if (t) {
    t.status = 'failed';
    t.reviewNote = 'Sếp không cấp quyền';
  }
  state.pendingPermission = undefined;
  save();
}

export function updateSettings(patch: Partial<OfficeState['settings']>) {
  state.settings = { ...state.settings, ...patch };
  save();
}

export function cancelJob(jobId: string) {
  const r = [...running.values()].find((x) => x.job.id === jobId);
  if (r) r.abort.abort();
  const j = state.jobs.find((x) => x.id === jobId);
  if (j && j.status !== 'running') j.status = 'failed';
  save();
}

export function retryTask(taskId: string) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (t) {
    t.status = 'todo';
    save();
    tick();
  }
}

export function resetOffice() {
  for (const r of running.values()) r.abort.abort();
  const keepDir = state.projectDir;
  state = freshState();
  if (keepDir) fs.rm(path.join(keepDir, '.office', 'state.json'), () => {});
  const cfg = readJson<Record<string, any>>(APP_CONFIG, {});
  writeJson(APP_CONFIG, { ...cfg, lastProject: undefined });
  save();
}

// ---------- jobs & scheduler ----------

function enqueue(kind: JobKind, employeeId: string, prompt: string, taskId?: string) {
  const job: Job = { id: `J${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind, employeeId, taskId, prompt, status: 'queued', attempts: 0, createdAt: Date.now() };
  state.jobs.push(job);
  setImmediate(tick);
  return job;
}

function accountBlockedUntil(acc: Account | undefined): number | undefined {
  if (!acc) return undefined;
  const now = Date.now();
  if (acc.coolingUntil && acc.coolingUntil > now) return acc.coolingUntil;
  return undefined;
}

export function busyMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, r] of running) out[id] = r.activity;
  return out;
}

let ticking = false;
export function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    let changed = false;

    // 1) wake up jobs whose quota window has reset
    for (const j of state.jobs) {
      if (j.status === 'waiting_quota' && j.resumeAt && j.resumeAt <= now) {
        j.status = 'queued';
        const e = staff(j.employeeId);
        if (e) {
          setCooling(e.accountId, undefined);
          e.status = 'idle';
          log(e.name, 'speech', '☕ Hết giờ nghỉ, quay lại làm tiếp!');
        }
        changed = true;
      }
    }

    // 2) materialize runnable tasks into execute jobs
    for (const t of state.tasks) {
      if (t.status !== 'todo') continue;
      if (state.jobs.some((j) => j.taskId === t.id && j.kind === 'execute' && (j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota'))) continue;
      const depsDone = t.dependsOn.every((d) => state.tasks.find((x) => x.id === d)?.status === 'done');
      if (!depsDone) continue;
      const missing = t.needs.filter((c) => !state.granted.includes(c) && !state.granted.includes('full_access'));
      if (missing.length) {
        if (!state.pendingPermission) {
          t.status = 'needs_permission';
          state.pendingPermission = { taskId: t.id, needs: missing, reason: `${t.id} "${t.title}" cần quyền: ${missing.join(', ')}` };
          log('Trưởng phòng', 'speech', `Sếp ơi, ${t.id} cần quyền ${missing.join(', ')}. Sếp cấp một lần là tôi dùng cho cả các lần sau.`);
          changed = true;
        }
        continue;
      }
      const e = staff(t.assigneeId);
      if (!e) {
        t.status = 'failed';
        t.reviewNote = 'Nhân viên được giao không còn trong văn phòng';
        changed = true;
        continue;
      }
      enqueue('execute', e.id, P.executePrompt(t), t.id);
      changed = true;
    }

    // 3) start queued jobs (one per employee, global parallel cap)
    for (const j of state.jobs) {
      if (j.status !== 'queued') continue;
      if (running.has(j.employeeId)) continue;
      if (running.size >= state.settings.maxParallel + 1) break; // +1: coordinator always gets a seat
      const e = staff(j.employeeId);
      const acc = e && getAccount(e.accountId);
      if (!e || !acc) {
        j.status = 'failed';
        j.error = 'Thiếu nhân viên hoặc tài khoản';
        changed = true;
        continue;
      }
      const blocked = accountBlockedUntil(acc);
      if (blocked) {
        if (failover(e, j)) {
          changed = true;
          continue;
        }
        parkForQuota(j, e, blocked);
        changed = true;
        continue;
      }
      void runJob(j, e, acc);
      changed = true;
    }

    // 4) all work for the current goal finished → coordinator writes the final report
    if (state.goal && !state.goalSummarized && state.tasks.length) {
      const goalTasks = state.tasks.filter((t) => t.createdAt >= (state.goalAt ?? 0));
      const finished = goalTasks.length && goalTasks.every((t) => t.status === 'done' || t.status === 'failed');
      const idle = !state.jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota');
      if (finished && idle) {
        state.goalSummarized = true;
        enqueue('summary', 'lead', P.summaryPrompt(state.goal, goalTasks));
        changed = true;
      }
    }

    if (changed) save();
  } finally {
    ticking = false;
  }
}

/** Move the employee to another account with headroom (if the boss enabled failover). */
function failover(e: Employee, j: Job): boolean {
  const mode = state.settings.failover;
  if (mode === 'off') return false;
  const cur = getAccount(e.accountId);
  const candidates = getAccounts()
    .filter((a) => a.id !== e.accountId && a.loggedIn && !accountBlockedUntil(a))
    .filter((a) => mode === 'any' || a.provider === e.provider)
    .filter((a) => (a.usage?.fiveHour?.usedPercent ?? 0) < 90 && (a.usage?.weekly?.usedPercent ?? 0) < 95)
    .sort(
      (a, b) =>
        (a.provider === e.provider ? 0 : 1) - (b.provider === e.provider ? 0 : 1) ||
        (a.usage?.fiveHour?.usedPercent ?? 0) - (b.usage?.fiveHour?.usedPercent ?? 0),
    );
  const next = candidates[0];
  if (!next) return false;
  const tier = listModels()[e.provider].find((m) => m.id === e.model)?.tier ?? 'standard';
  if (next.provider !== e.provider) {
    e.provider = next.provider;
    e.model = pickModel(next.provider, tier === 'max' ? 'high' : tier).id;
  }
  e.accountId = next.id;
  e.sessionId = undefined; // sessions live in the old account's config dir; notes carry the memory
  e.sessionGeneration++;
  e.status = 'idle';
  e.statusText = undefined;
  j.status = 'queued';
  j.resumeAt = undefined;
  log(e.name, 'speech', `🔄 ${cur?.label ?? 'Tài khoản cũ'} hết hạn mức — chuyển sang ${next.label} để làm tiếp.`);
  return true;
}

function parkForQuota(j: Job, e: Employee, resetsAt: number) {
  // +90s buffer so we don't hit the wall again right at the reset second.
  j.resumeAt = resetsAt + Number(process.env.NEXCANVAS_RESUME_BUFFER_MS ?? 90_000);
  j.status = 'waiting_quota';
  e.status = 'sleeping';
  const when = new Date(j.resumeAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  e.statusText = `Hết hạn mức — tự làm tiếp lúc ${when}`;
  if (j.taskId) {
    const t = state.tasks.find((x) => x.id === j.taskId);
    if (t) t.status = 'waiting_quota';
  }
  log(e.name, 'speech', `😴 Hết hạn mức rồi, tôi nghỉ đến ${when} rồi tự làm tiếp.`);
}

async function runJob(job: Job, e: Employee, acc: Account) {
  const abort = new AbortController();
  running.set(e.id, { job, abort, activity: 'Đang suy nghĩ…' });
  job.status = 'running';
  job.attempts++;
  e.status = 'working';
  e.statusText = jobLabel(job);
  if (job.taskId) {
    const t = state.tasks.find((x) => x.id === job.taskId);
    if (t && job.kind === 'execute') {
      t.status = 'in_progress';
      t.updatedAt = Date.now();
    }
  }
  save();

  // Rotate an over-grown session: the employee's notes file carries the memory into a fresh one.
  if (e.sessionId && e.stats.contextTokens > state.settings.rotateAtTokens && !e.isCoordinator) {
    e.sessionId = undefined;
    e.sessionGeneration++;
    log(e.name, 'system', 'Phiên làm việc đã dài — giao ca sang phiên mới (đọc lại sổ tay).');
  }

  let cwd = state.projectDir!;
  let conflicts: string[] = [];
  try {
    cwd = workdirFor(e);
  } catch (err: any) {
    log('Hệ thống', 'error', `Không tạo được thư mục làm việc riêng cho ${e.name}: ${err.message}. Dùng thư mục chung.`);
  }
  if (e.workdir && e.workdir !== cwd && e.sessionId && e.provider === 'claude') {
    // Claude sessions are bound to their folder: moving folders = new session (notes carry the memory).
    e.sessionId = undefined;
    e.sessionGeneration++;
  }
  e.workdir = cwd;
  if (job.kind === 'execute' && cwd !== state.projectDir && job.attempts === 1) {
    conflicts = G.syncFromMain(state.projectDir!, cwd).conflicts;
  }

  const officeAbs = path.join(state.projectDir!, '.office').split(path.sep).join('/');
  const parts: string[] = [];
  if (job.kind === 'execute') {
    if (conflicts.length) {
      parts.push(`⚠️ Code của đồng nghiệp vừa được gộp vào nhánh của bạn và có XUNG ĐỘT ở: ${conflicts.join(', ')}. Giải quyết xung đột trước (giữ đúng ý của cả hai bên), rồi mới làm task.`);
    }
    if (job.attempts > 1) {
      parts.push('⚠️ Bạn vừa bị gián đoạn (hết hạn mức hoặc lỗi). Kiểm tra trạng thái file hiện tại rồi TIẾP TỤC, không làm lại phần đã xong.');
    }
    if (!e.sessionId) {
      // New session (first task, rotation or account switch): bootstrap from the shared brief + own handover notes.
      const hasNotes = fs.existsSync(path.join(state.projectDir!, '.office', 'agents', `${e.id}.md`));
      parts.push(`Trước khi bắt đầu: đọc ${officeAbs}/BRIEF.md${hasNotes ? ` và sổ tay giao ca ${officeAbs}/agents/${e.id}.md` : ''}.`);
    }
  }
  parts.push(job.prompt);
  const prompt = parts.join('\n\n');

  const schema = e.isCoordinator ? P.COORDINATOR_SCHEMA : P.REPORT_SCHEMA;

  const req = {
    account: acc,
    cwd,
    // Workers in a worktree still need the shared office folder (brief + their own notes).
    // The coordinator gets the (constant) worktree root so it can open employees' files while reviewing.
    extraDirs: cwd !== state.projectDir ? [officeAbs] : e.isCoordinator && state.gitRepo ? [ensureDir(G.worktreeRoot(state.projectDir!))] : [],
    model: e.model,
    effort: e.effort,
    sessionId: e.sessionId,
    prompt,
    systemAppend: e.isCoordinator ? P.coordinatorCard(template) : P.employeeCard(e, roleDuty(e.roleKey), officeAbs),
    schema,
    granted: state.granted,
    // Lean = no MCP servers in the session (they add ~10k tokens of tool definitions per turn).
    lean: state.settings.leanMode,
    readOnly: e.isCoordinator,
    signal: abort.signal,
    onActivity: (text: string) => {
      const r = running.get(e.id);
      if (r) r.activity = text;
      bubble(e.id, text);
    },
    onUsage: (u: any) => {
      updateAccountUsage(acc.id, u);
      notify();
    },
  };

  let res: TurnResult;
  try {
    if (process.env.NEXCANVAS_SIMULATE_LIMIT && job.kind === 'execute' && !simulatedLimit) {
      // Dev aid: fake a usage-limit hit once (resets in N seconds) to exercise the sleep → resume path.
      simulatedLimit = true;
      const secs = Number(process.env.NEXCANVAS_SIMULATE_LIMIT) || 30;
      res = { ok: false, text: '', error: 'simulated usage limit', limited: { resetsAt: Date.now() + secs * 1000 }, usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
    } else
    res = e.provider === 'claude' ? await runClaude(req) : await runCodex(req);
  } catch (err: any) {
    res = { ok: false, text: '', error: err?.message ?? String(err), usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
  }
  running.delete(e.id);
  const pctCached = Math.round((100 * res.usage.cached) / Math.max(1, res.usage.cached + res.usage.input));
  console.log(
    `[turn] ${e.name.padEnd(12)} ${job.kind.padEnd(8)} new=${res.usage.input} cached=${res.usage.cached} (${pctCached}%) out=${res.usage.output} ok=${res.ok}${res.limited ? ' LIMITED' : ''}`,
  );

  if (res.sessionId) e.sessionId = res.sessionId;
  e.stats.turns++;
  e.stats.inputTokens += res.usage.input;
  e.stats.outputTokens += res.usage.output;
  e.stats.cachedTokens += res.usage.cached;
  e.stats.costUsd += res.costUsd;
  if (res.usage.contextTokens) e.stats.contextTokens = res.usage.contextTokens;
  e.status = 'idle';
  e.statusText = undefined;

  if (abort.signal.aborted) {
    job.status = 'failed';
    job.error = 'Đã hủy';
    log(e.name, 'info', 'Đã dừng theo yêu cầu.');
  } else if (res.limited) {
    // The whole point: never give up on a task because of quota — sleep and resume the same session.
    const resetsAt = res.limited.resetsAt ?? acc.usage?.fiveHour?.resetsAt ?? Date.now() + 5 * 3600_000;
    setCooling(acc.id, resetsAt);
    job.status = 'queued';
    if (!failover(e, job)) parkForQuota(job, e, resetsAt);
    // Everyone else on the same account is going to sleep too.
    for (const other of allStaff()) {
      if (other.id !== e.id && other.accountId === acc.id && !running.has(other.id)) {
        other.status = 'sleeping';
        other.statusText = e.statusText;
      }
    }
  } else if (!res.ok) {
    job.error = res.error;
    if (job.attempts < 3) {
      job.status = 'queued';
      log(e.name, 'error', `Lỗi, thử lại (${job.attempts}/3): ${String(res.error).slice(0, 160)}`);
    } else {
      job.status = 'failed';
      log(e.name, 'error', `Thất bại: ${String(res.error).slice(0, 200)}`);
      if (job.taskId) {
        const t = state.tasks.find((x) => x.id === job.taskId);
        if (t) t.status = 'failed';
      }
      if (job.kind === 'analyze') state.phase = 'context';
    }
  } else {
    job.status = 'done';
    handleResult(job, e, res);
  }
  save();
  setImmediate(tick);
}

function jobLabel(j: Job) {
  switch (j.kind) {
    case 'analyze': return 'Đọc dự án & đề xuất nhân sự';
    case 'plan': return 'Lập kế hoạch';
    case 'execute': return `Làm ${j.taskId}`;
    case 'review': return `Review ${j.taskId}`;
    case 'summary': return 'Viết báo cáo cho sếp';
    default: return 'Trao đổi';
  }
}

function handleResult(job: Job, e: Employee, res: TurnResult) {
  const out = res.structured;
  switch (job.kind) {
    case 'analyze': {
      if (!out?.team) {
        log(e.name, 'error', 'Không đọc được đề xuất (JSON lỗi). Thử phân tích lại.');
        state.phase = 'context';
        return;
      }
      const proposal: Proposal = {
        summary: out.summary,
        risks: out.risks ?? [],
        team: (out.team as any[]).slice(0, template.maxEmployees).map((r) => ({ ...r, skills: (r.skills ?? []).slice(0, 4) })),
      };
      state.proposal = proposal;
      if (out.brief_markdown && state.projectDir) {
        fs.writeFileSync(path.join(state.projectDir, '.office', 'BRIEF.md'), out.brief_markdown);
      }
      state.phase = 'proposal';
      log(e.name, 'speech', `${proposal.summary}\n\nTôi đề xuất ${proposal.team.length} nhân viên: ${proposal.team.map((t) => t.title).join(', ')}.`);
      break;
    }
    case 'plan': {
      const reply = out?.reply ?? res.text;
      log(e.name, 'speech', reply);
      const tasks = (out?.tasks ?? []) as any[];
      if (!tasks.length) return;
      state.goalAt = Date.now();
      const keyToId = new Map<string, string>();
      let n = state.tasks.length;
      for (const t of tasks) keyToId.set(t.key, `TASK-${String(++n).padStart(3, '0')}`);
      const validIds = new Set(state.employees.map((x) => x.id));
      for (const t of tasks) {
        const assignee = validIds.has(t.assignee) ? t.assignee : state.employees[0]?.id;
        if (!assignee) continue;
        state.tasks.push({
          id: keyToId.get(t.key)!,
          title: t.title,
          description: t.description,
          acceptance: t.acceptance,
          assigneeId: assignee,
          dependsOn: (t.dependsOn ?? []).map((k: string) => keyToId.get(k)).filter(Boolean),
          needs: (t.needs ?? []) as Capability[],
          status: 'todo',
          revisions: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      log(e.name, 'info', `📋 Đã giao ${tasks.length} task.`);
      break;
    }
    case 'execute': {
      const t = state.tasks.find((x) => x.id === job.taskId);
      if (!t) return;
      const report: TaskReport = out?.summary
        ? out
        : { status: 'done', summary: res.text.slice(0, 600), files_changed: [], tests: '', blockers: '' };
      t.report = report;
      t.updatedAt = Date.now();
      if (state.projectDir) {
        fs.writeFileSync(path.join(state.projectDir, '.office', 'reports', `${t.id}.json`), JSON.stringify(report, null, 2));
      }
      log(e.name, 'speech', `✅ ${t.id}: ${report.summary.slice(0, 220)}`);
      t.status = 'review';
      const wt = e.workdir && e.workdir !== state.projectDir ? e.workdir : undefined;
      const diff = wt ? G.reviewDiff(wt) : { stat: state.projectDir ? G.sharedDiffStat(state.projectDir) : '', patch: '' };
      enqueue('review', 'lead', P.reviewPrompt(t, report, diff.stat, diff.patch, wt), t.id);
      break;
    }
    case 'review': {
      const t = state.tasks.find((x) => x.id === job.taskId);
      if (!t) return;
      const verdict = out?.verdict ?? 'approve';
      t.updatedAt = Date.now();
      if (verdict === 'approve' || t.revisions >= state.settings.maxRevisions) {
        t.reviewNote = out?.feedback ?? undefined;
        if (!mergeTask(t)) return;
        t.status = 'done';
        log(e.name, 'speech', `👍 Duyệt ${t.id}${out?.feedback ? `: ${String(out.feedback).slice(0, 160)}` : ''}`);
      } else {
        t.revisions++;
        t.reviewNote = out?.feedback;
        t.status = 'todo';
        log(e.name, 'speech', `🔁 ${t.id} cần sửa: ${String(out?.feedback ?? '').slice(0, 200)}`);
      }
      break;
    }
    case 'summary': {
      // The model often starts with its own "Báo cáo:" heading — drop it, the UI already labels reports.
      const reply = String(out?.reply ?? res.text).replace(/^\s*(#+\s*)?\**\s*Báo cáo[^:\n]*:?\**\s*/i, '');
      log(e.name, 'speech', `📣 Báo cáo: ${reply}`);
      if (state.projectDir) {
        fs.writeFileSync(path.join(state.projectDir, '.office', 'reports', `summary-${Date.now()}.md`), reply);
      }
      break;
    }
    default:
      log(e.name, 'speech', out?.reply ?? res.text);
  }
}

/** Merge the assignee's branch into main. On conflict the task goes back to the assignee. Returns true when done. */
function mergeTask(t: Task): boolean {
  const worker = state.employees.find((x) => x.id === t.assigneeId);
  if (!worker?.workdir || !worker.branch || worker.workdir === state.projectDir || !state.projectDir) return true;
  const r = G.mergeIntoMain(state.projectDir, worker.workdir, worker.branch, `${t.id} ${t.title}`);
  if (r.ok) {
    t.merge = { status: 'merged', commit: r.commit };
    log('Hệ thống', 'info', `🔀 Đã gộp ${t.id} vào nhánh ${state.mainBranch ?? 'chính'} (${r.commit}).`);
    return true;
  }
  if (r.conflicts.length && t.revisions < state.settings.maxRevisions + 2) {
    t.merge = { status: 'conflict', files: r.conflicts };
    t.revisions++;
    t.status = 'todo';
    t.reviewNote = `Xung đột khi gộp với code của đồng nghiệp ở: ${r.conflicts.join(', ')}. Các file đang có dấu xung đột trong thư mục của bạn — hãy giải quyết.`;
    log('Trưởng phòng', 'speech', `⚔️ ${t.id} xung đột với code đồng nghiệp (${r.conflicts.join(', ')}) — giao lại cho ${worker.name} xử lý.`);
    return false;
  }
  t.merge = { status: 'failed', note: r.ok ? '' : r.error ?? 'Không gộp được' };
  log('Hệ thống', 'error', `Không gộp được ${t.id}: ${t.merge.note}. Code vẫn nằm trên nhánh ${worker.branch}.`);
  return true;
}

function diffStat(): string {
  if (!state.projectDir) return '';
  try {
    return execFileSync('git', ['diff', '--stat', 'HEAD'], { cwd: state.projectDir, encoding: 'utf8', timeout: 10000 }).slice(0, 3000);
  } catch {
    return '';
  }
}

export function startScheduler() {
  setInterval(tick, 5000);
}
