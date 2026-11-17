// Offices: up to MAX_OFFICES independent offices (code / video / other), each with its own state,
// job queue and scheduler. AsyncLocalStorage binds every async continuation (agent turns, timers)
// to the office it belongs to, so several offices can work in parallel without mixing state.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CHAT_IMAGES,
  MAX_EVIDENCE,
  MAX_IMAGE_BYTES,
  MAX_OFFICES,
  type Evidence,
  type ImageUpload,
  type Account,
  type Capability,
  type Employee,
  type Job,
  type JobKind,
  type Lang,
  type LogEntry,
  type LogTag,
  type OfficeState,
  type OfficeSummary,
  type OfficeType,
  type Proposal,
  type Provider,
  type Task,
  type TaskReport,
  type TemplateInfo,
} from '../shared/types.ts';
import { getAccount, getAccounts, listModels, pickModel, setCooling, updateAccountUsage } from './accounts.ts';
import { APP_CONFIG, APP_DIR, readJson, writeJson } from './paths.ts';
import * as P from './prompts.ts';
import { runClaude } from './runner/claude.ts';
import { runCodex } from './runner/codex.ts';
import type { TurnResult } from './runner/types.ts';
import { scanSkills, skillCatalog } from './skills.ts';
import * as G from './git.ts';
import { DEFAULT_NAMES, LOCALE, UserError, tr } from './i18n.ts';

// ---------- templates ----------

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const TEMPLATES: Record<OfficeType, P.OfficeTemplate> = Object.fromEntries(
  (['code', 'video', 'other'] as OfficeType[]).map((id) => [id, JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${id}.json`), 'utf8'))]),
) as Record<OfficeType, P.OfficeTemplate>;

export function templateInfos(): TemplateInfo[] {
  return Object.values(TEMPLATES).map((t) => ({ id: t.id, icon: t.icon, locked: !!t.locked, maxEmployees: t.maxEmployees, i18n: t.i18n }));
}

// ---------- office contexts ----------

interface RunInfo {
  job: Job;
  abort: AbortController;
  activity: string;
}
interface Ctx {
  id: string;
  state: OfficeState;
  running: Map<string, RunInfo>;
  simulatedLimit: boolean;
  ticking: boolean;
  saveTimer?: NodeJS.Timeout;
}

const als = new AsyncLocalStorage<Ctx>();
const offices = new Map<string, Ctx>();
let activeId: string | undefined;
let appLang: Lang | undefined;

const OFFICES_DIR = path.join(APP_DIR, 'offices');
const stateFile = (id: string) => path.join(OFFICES_DIR, id, 'state.json');

function cx(): Ctx {
  const c = als.getStore() ?? (activeId ? offices.get(activeId) : undefined);
  if (!c) throw new UserError(tr(appLang ?? 'en', 'err.noOffice'));
  return c;
}
const S = () => cx().state;
const R = () => cx().running;
const tpl = () => TEMPLATES[S().template];
/** Language for messages: the office's own language, else the app language. */
const lang = (): Lang => (als.getStore() ?? (activeId ? offices.get(activeId) : undefined))?.state.language ?? appLang ?? 'en';
const T = (key: string, vars?: Record<string, string | number>) => tr(lang(), key, vars);
const err = (key: string, vars?: Record<string, string | number>) => new UserError(T(key, vars));

/** Run `fn` later, still bound to the current office. */
function later(fn: () => void, ms = 0) {
  const c = cx();
  const run = () => als.run(c, fn);
  if (ms) setTimeout(run, ms);
  else setImmediate(run);
}

/** Called whenever state changes so the server can push a snapshot to the UI. */
let notify: () => void = () => {};
let bubble: (officeId: string, employeeId: string, text: string) => void = () => {};
export function onChange(fn: () => void) {
  notify = fn;
}
export function onBubble(fn: (officeId: string, id: string, text: string) => void) {
  bubble = fn;
}

const SKINS = ['#f5d0a9', '#e8b88a', '#c68e5a', '#8d5a3b', '#f9dcc4'];
const HAIRS = ['#2b1d16', '#5a3825', '#c9a227', '#1d1d2b', '#a33b2e', '#6b6b7b', '#e6e1d6'];
const SHIRTS = ['#e85d4a', '#4a90e2', '#50b36b', '#9b59d0', '#f2a93b', '#2fb6a8', '#e45f9b', '#5c6bc0'];
const PANTS = ['#2f3542', '#3b4a6b', '#4b3b2f', '#22313f'];

function freshState(id: string, name: string, template: OfficeType, language: Lang): OfficeState {
  return {
    version: 1,
    id,
    name,
    template,
    language,
    createdAt: Date.now(),
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

function save() {
  const c = cx();
  clearTimeout(c.saveTimer);
  c.saveTimer = setTimeout(() => writeJson(stateFile(c.id), c.state), 200);
  notify();
}

// ---------- registry (app config) ----------

interface AppConfig {
  language?: Lang;
  offices?: string[];
  activeOffice?: string;
  recentProjects?: string[];
  [k: string]: unknown;
}
const readCfg = () => readJson<AppConfig>(APP_CONFIG, {});
function writeCfg(patch: Partial<AppConfig>) {
  writeJson(APP_CONFIG, { ...readCfg(), ...patch, offices: [...offices.keys()], activeOffice: activeId });
}

export function loadAll() {
  const cfg = readCfg();
  appLang = cfg.language;
  for (const id of cfg.offices ?? []) {
    const st = readJson<OfficeState | null>(stateFile(id), null);
    if (!st || st.version !== 1 || !st.id) continue;
    const fresh = freshState(st.id, st.name, st.template, st.language);
    const state: OfficeState = { ...fresh, ...st, settings: { ...fresh.settings, ...st.settings } };
    // Anything that was mid-flight when the app closed gets re-queued (sessions are resumed, so no work is lost).
    for (const j of state.jobs) if (j.status === 'running') j.status = 'queued';
    for (const e of [state.coordinator, ...state.employees]) if (e && (e.status === 'working' || e.status === 'walking-in')) e.status = 'idle';
    offices.set(id, { id, state, running: new Map(), simulatedLimit: false, ticking: false });
    als.run(offices.get(id)!, refreshGitInfo);
  }
  activeId = cfg.activeOffice && offices.has(cfg.activeOffice) ? cfg.activeOffice : undefined;
}

export function getLanguage() {
  return appLang;
}
export function setLanguage(l: Lang) {
  appLang = l;
  writeCfg({ language: l });
  notify();
}

export function activeState(): OfficeState | undefined {
  return activeId ? offices.get(activeId)?.state : undefined;
}

export function listOffices(): OfficeSummary[] {
  return [...offices.values()]
    .map(({ state: s }) => {
      const staff = [s.coordinator, ...s.employees].filter(Boolean) as Employee[];
      return {
        id: s.id,
        name: s.name,
        template: s.template,
        projectDir: s.projectDir,
        mainBranch: s.mainBranch,
        phase: s.phase,
        employees: s.employees.length,
        working: staff.filter((e) => e.status === 'working').length,
        sleeping: staff.filter((e) => e.status === 'sleeping').length,
        openTasks: s.tasks.filter((t) => t.status !== 'done' && t.status !== 'failed').length,
        doneTasks: s.tasks.filter((t) => t.status === 'done').length,
        createdAt: s.createdAt,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function createOffice(type: OfficeType, name?: string) {
  if (offices.size >= MAX_OFFICES) throw err('err.maxOffices', { n: MAX_OFFICES });
  if (!TEMPLATES[type] || TEMPLATES[type].locked) throw err('err.locked');
  const l = appLang ?? 'en';
  const id = `o${Date.now().toString(36)}`;
  const sameType = [...offices.values()].filter((o) => o.state.template === type).length;
  const base = TEMPLATES[type].i18n[l].name;
  const state = freshState(id, name?.trim() || (sameType ? `${base} ${sameType + 1}` : base), type, l);
  const c: Ctx = { id, state, running: new Map(), simulatedLimit: false, ticking: false };
  offices.set(id, c);
  activeId = id;
  writeCfg({});
  als.run(c, save);
  return id;
}

export function openOffice(id: string) {
  if (!offices.has(id)) throw err('err.noOffice');
  activeId = id;
  writeCfg({});
  notify();
}

export function closeOffice() {
  activeId = undefined;
  writeCfg({});
  notify();
}

export function renameOffice(id: string, name: string) {
  const c = offices.get(id);
  if (!c || !name.trim()) return;
  c.state.name = name.trim().slice(0, 40);
  als.run(c, save);
}

export function deleteOffice(id: string) {
  const c = offices.get(id);
  if (!c) return;
  if (c.running.size) throw err('err.officeBusy');
  const s = c.state;
  if (s.projectDir) for (const e of s.employees) if (e.workdir && e.workdir !== s.projectDir) G.removeWorktree(s.projectDir, e.workdir);
  offices.delete(id);
  fs.rm(path.dirname(stateFile(id)), { recursive: true, force: true }, () => {});
  if (activeId === id) activeId = undefined;
  writeCfg({});
  notify();
}

function rememberProject(dir: string) {
  const recent = [dir, ...(readCfg().recentProjects ?? []).filter((p) => p !== dir)].slice(0, 8);
  writeCfg({ recentProjects: recent });
}

export function recentProjects(): string[] {
  return readCfg().recentProjects ?? [];
}

// ---------- helpers ----------

function refreshGitInfo() {
  const s = S();
  if (!s.projectDir) return;
  s.gitRepo = G.isGitRepo(s.projectDir);
  s.mainBranch = s.gitRepo ? G.currentBranch(s.projectDir) : undefined;
}

function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
  return d.split(path.sep).join('/');
}

function useWorktrees() {
  const s = S();
  if (!s.projectDir || !s.gitRepo) return false;
  return s.settings.isolation === 'worktree' || (s.settings.isolation === 'auto' && s.employees.length > 1);
}

/**
 * Where an employee works. With isolation, each one gets a git worktree on its own branch so
 * parallel edits never collide; the server merges approved work back into the main branch.
 */
function workdirFor(e: Employee): string {
  const s = S();
  if (e.isCoordinator || !useWorktrees()) return s.projectDir!;
  e.branch ??= G.branchFor(e.id, e.name);
  return G.ensureWorktree(s.projectDir!, e.id, e.branch);
}

function log(who: string, kind: LogEntry['kind'], text: string, tag?: LogTag, images?: string[]) {
  const s = S();
  s.log.push({ at: Date.now(), who, kind, text, ...(tag ? { tag } : {}), ...(images?.length ? { images } : {}) });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

export function allStaff(): Employee[] {
  const s = S();
  return s.coordinator ? [s.coordinator, ...s.employees] : [...s.employees];
}

function staff(id: string) {
  return allStaff().find((e) => e.id === id);
}

const pick = <T,>(arr: T[], i: number) => arr[Math.abs(i) % arr.length];

function newLook(seed: number): Employee['look'] {
  return { skin: pick(SKINS, seed * 3), hair: pick(HAIRS, seed * 5 + 1), shirt: pick(SHIRTS, seed * 7 + 2), pants: pick(PANTS, seed), hairStyle: seed % 4 };
}

function roleDuty(roleKey: string) {
  return tpl().roles.find((r) => r.key === roleKey)?.duty ?? 'Do the tasks assigned to you within your expertise.';
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
  const s = S();
  const acc = getAccount(opts.accountId);
  if (!acc || acc.provider !== opts.provider) throw err('err.invalidAccount');
  // The office language is locked in when the lead is appointed (no agent session exists before that).
  if (!s.coordinator && appLang) s.language = appLang;
  const model = opts.model || pickModel(opts.provider, 'high').id;
  s.coordinator = {
    id: 'lead',
    name: T('lead.name'),
    roleKey: 'coordinator',
    title: T('lead.title'),
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
  s.phase = s.projectDir ? 'context' : 'choose-folder';
  log('lead', 'speech', T('greet', { acc: acc.label, model }));
  save();
}

export function chooseFolder(dir: string) {
  const s = S();
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw err('err.folderMissing');
  const other = [...offices.values()].find((o) => o.id !== s.id && o.state.projectDir && path.resolve(o.state.projectDir).toLowerCase() === abs.toLowerCase());
  if (other) throw err('err.folderTaken', { name: other.state.name });
  s.projectDir = abs;
  refreshGitInfo();
  ensureOfficeFolder(abs);
  rememberProject(abs);
  s.phase = 'context';
  log('lead', 'speech', T('askContext'));
  save();
}

export function addContextFile(name: string, content: string) {
  const s = S();
  if (!s.projectDir) throw err('err.noFolder');
  const safe = name.replace(/[^\p{L}\p{N}._\- ]+/gu, '_').replace(/\.(txt|md)$/i, '') + '.txt';
  fs.writeFileSync(path.join(s.projectDir, '.office', 'context', safe), content);
  if (!s.contextFiles.includes(safe)) s.contextFiles.push(safe);
  log('system', 'system', T('contextAdded', { name: safe, k: Math.round(content.length / 1000) }));
  save();
}

export function removeContextFile(name: string) {
  const s = S();
  s.contextFiles = s.contextFiles.filter((f) => f !== name);
  if (s.projectDir) fs.rm(path.join(s.projectDir, '.office', 'context', name), () => {});
  save();
}

/** The lead must understand the project before anyone is hired: analysis always comes first. */
export function startAnalysis(feedback?: string) {
  const s = S();
  if (!s.coordinator || !s.projectDir) throw err('err.notReady');
  s.phase = 'analyzing';
  const skills = scanSkills(s.projectDir);
  enqueue('analyze', 'lead', P.analyzePrompt({ template: tpl(), contextFiles: s.contextFiles, skillCatalog: skillCatalog(skills), feedback }));
  log('lead', 'speech', feedback ? T('reanalyzing') : T('analyzing'));
  save();
}

/** Account must exist and match the provider; model must be one that provider offers. */
function validateAssignment(provider: Provider, accountId: string, model: string) {
  const acc = getAccount(accountId);
  if (!acc) throw err('err.noAccount', { id: accountId });
  if (acc.provider !== provider) throw err('err.accProvider', { label: acc.label, is: acc.provider, want: provider });
  if (!listModels()[provider].some((m) => m.id === model)) throw err('err.model', { model, provider });
}

export function acceptProposal() {
  const s = S();
  if (!s.proposal) throw err('err.noProposal');
  s.phase = 'staffing';
  save();
}

/** Re-open setup to add more staff later (office keeps running). */
export function openStaffing() {
  const s = S();
  if (!s.proposal) s.proposal = { summary: '', team: [], risks: [] };
  s.phase = 'staffing';
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
  const s = S();
  const accs = getAccounts().filter((a) => a.loggedIn);
  if (!s.proposal || !accs.length) return [];
  // Prefer accounts with headroom in BOTH windows; a nearly exhausted weekly quota is a strong no.
  const load = new Map<string, number>(
    accs.map((a) => {
      const five = a.usage?.fiveHour?.usedPercent ?? 0;
      const week = a.usage?.weekly?.usedPercent ?? 0;
      return [a.id, Math.max(five, week) / 25 + (week >= 85 ? 10 : 0) + (a.coolingUntil && a.coolingUntil > Date.now() ? 20 : 0)];
    }),
  );
  if (s.coordinator) load.set(s.coordinator.accountId, (load.get(s.coordinator.accountId) ?? 0) + 1);
  return s.proposal.team.map((r) => {
    const acc = [...accs].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
    load.set(acc.id, (load.get(acc.id) ?? 0) + 1);
    const model = pickModel(acc.provider, r.modelTier);
    return { roleKey: r.roleKey, title: r.title, provider: acc.provider, accountId: acc.id, model: model.id, effort: r.modelTier === 'high' ? 'high' : 'medium', skills: r.skills };
  });
}

export function hire(specs: HireSpec[]) {
  const s = S();
  const max = tpl().maxEmployees;
  if (specs.length + s.employees.length > max) throw err('err.maxEmployees', { n: max });
  for (const spec of specs) validateAssignment(spec.provider, spec.accountId, spec.model);
  const used = new Set(s.employees.map((e) => e.desk));
  const names = DEFAULT_NAMES[s.language];
  for (const spec of specs) {
    const desk = [0, 1, 2, 3, 4, 5].find((d) => !used.has(d))!;
    used.add(desk);
    const seed = s.employees.length + desk + 1;
    const name = spec.name || names.find((n) => !s.employees.some((e) => e.name === n)) || `#${seed}`;
    const id = `e${Date.now().toString(36)}${desk}`;
    s.employees.push({
      id,
      name,
      roleKey: spec.roleKey,
      title: spec.title,
      isCoordinator: false,
      provider: spec.provider,
      accountId: spec.accountId,
      model: spec.model,
      effort: spec.effort,
      skills: spec.skills,
      sessionGeneration: 0,
      status: 'walking-in',
      desk,
      look: newLook(seed * 13 + desk),
      stats: { turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, contextTokens: 0 },
    });
    log(id, 'speech', T('hello', { name, title: spec.title }));
  }
  s.phase = 'ready';
  save();
  later(() => {
    for (const e of S().employees) if (e.status === 'walking-in') e.status = 'idle';
    save();
  }, 6000);
}

export function updateEmployee(id: string, patch: Partial<Pick<Employee, 'name' | 'title' | 'provider' | 'accountId' | 'model' | 'effort' | 'skills'>>) {
  const e = staff(id);
  if (!e) throw err('err.noEmployee');
  if (R().has(id)) throw err('err.busyConfig');
  validateAssignment(patch.provider ?? e.provider, patch.accountId ?? e.accountId, patch.model ?? e.model);
  const providerChanged = patch.provider && patch.provider !== e.provider;
  const accountChanged = patch.accountId && patch.accountId !== e.accountId;
  Object.assign(e, patch);
  if (providerChanged || accountChanged) {
    // A session lives inside one account's config dir, so switching account starts a new one;
    // the employee's notebook carries the memory across.
    e.sessionId = undefined;
    e.sessionGeneration++;
    e.stats.contextTokens = 0;
    // Work parked for quota on the old account can start right away on the new one.
    if (!accountBlockedUntil(getAccount(e.accountId))) {
      for (const j of S().jobs) {
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
    later(tick);
  }
  log('system', 'system', T('updated', { name: e.name, fields: Object.keys(patch).join(', ') }));
  save();
}

export function fire(id: string) {
  const s = S();
  if (R().has(id)) throw err('err.busy');
  const leaving = s.employees.find((e) => e.id === id);
  if (leaving?.workdir && s.projectDir && leaving.workdir !== s.projectDir) G.removeWorktree(s.projectDir, leaving.workdir);
  s.employees = s.employees.filter((e) => e.id !== id);
  s.jobs = s.jobs.filter((j) => j.employeeId !== id || j.status === 'done');
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

export function accountInUse(accountId: string) {
  return [...offices.values()].some((o) => [o.state.coordinator, ...o.state.employees].some((e) => e?.accountId === accountId));
}

// ---------- boss ↔ lead ----------

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ATTACHMENT_NAME = /^[\w.-]+\.(png|jpg|gif|webp)$/;

type ImageDir = 'attachments' | 'evidence';
const IMAGE_DIRS: ImageDir[] = ['attachments', 'evidence'];

/** Decode uploaded images (data URLs) into .office/<sub> and return their file names. */
function saveImages(uploads: ImageUpload[], sub: ImageDir = 'attachments', prefix?: string): string[] {
  const s = S();
  const dir = ensureDir(path.join(s.projectDir!, '.office', sub));
  const stamp = prefix ?? new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return uploads.map((u, i) => {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(String(u.data ?? ''));
    if (!m) throw err('err.badImage');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw err('err.imageTooBig', { mb: MAX_IMAGE_BYTES / 1024 / 1024 });
    const name = `${stamp}-${Math.random().toString(36).slice(2, 6)}-${i + 1}.${IMAGE_EXT[m[1]]}`;
    fs.writeFileSync(path.join(dir, name), bytes);
    return name;
  });
}

/** Absolute path of an office image (chat attachment or evidence), or undefined if the name is invalid / missing. */
export function officeImageFile(officeId: string, sub: string, name: string): string | undefined {
  const dir = offices.get(officeId)?.state.projectDir;
  if (!dir || !IMAGE_DIRS.includes(sub as ImageDir) || !ATTACHMENT_NAME.test(name)) return undefined;
  const file = path.join(dir, '.office', sub, name);
  return fs.existsSync(file) ? file : undefined;
}

/** Job image paths ("attachments/x.png", "evidence/y.png") → absolute paths that exist. */
const officePaths = (rel?: string[]) =>
  (rel ?? [])
    .filter((r) => /^(attachments|evidence)\/[\w.-]+$/.test(r))
    .map((r) => path.join(S().projectDir!, '.office', r))
    .filter((f) => fs.existsSync(f));

/** The screenshot helper employees run for evidence (ships with the app). */
const SHOT_TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'shot.mjs').split(path.sep).join('/');
const EVIDENCE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** Copy the screenshots an employee listed in its report into .office/evidence. Boss-added images are kept. */
function collectEvidence(t: Task, e: Employee, report: TaskReport) {
  const s = S();
  const dir = ensureDir(path.join(s.projectDir!, '.office', 'evidence'));
  const old = t.evidence ?? [];
  for (const x of old.filter((x) => x.by === 'agent')) fs.rmSync(path.join(dir, x.file), { force: true });
  const bases = [e.workdir, s.projectDir, path.join(s.projectDir!, '.office')].filter(Boolean) as string[];
  const out: Evidence[] = [];
  for (const ev of (Array.isArray(report.evidence) ? report.evidence : []).slice(0, 4)) {
    const p = String(ev?.path ?? '').trim();
    if (!p) continue;
    const src = (path.isAbsolute(p) ? [p] : bases.map((b) => path.resolve(b, p))).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    const ext = src && path.extname(src).toLowerCase();
    if (!src || !ext || !EVIDENCE_EXT.includes(ext) || fs.statSync(src).size > MAX_IMAGE_BYTES) continue;
    const name = `${t.id}-${Date.now().toString(36)}-${out.length + 1}${ext === '.jpeg' ? '.jpg' : ext}`;
    fs.copyFileSync(src, path.join(dir, name));
    // The raw shot was saved straight into the evidence folder: keep only the renamed copy.
    if (path.resolve(path.dirname(src)) === path.resolve(dir)) fs.rmSync(src, { force: true });
    out.push({ file: name, caption: String(ev.caption ?? '').slice(0, 240), by: 'agent', at: Date.now() });
  }
  t.evidence = [...out, ...old.filter((x) => x.by === 'boss')];
}

export function addEvidence(taskId: string, upload: ImageUpload, caption = '') {
  const t = S().tasks.find((x) => x.id === taskId);
  if (!t) throw err('err.noTask', { id: taskId });
  if ((t.evidence?.length ?? 0) >= MAX_EVIDENCE) throw err('err.tooManyImages', { n: MAX_EVIDENCE });
  const [file] = saveImages([upload], 'evidence', `${t.id}-boss`);
  t.evidence = [...(t.evidence ?? []), { file, caption: caption.slice(0, 240), by: 'boss', at: Date.now() }];
  save();
}

export function removeEvidence(taskId: string, file: string) {
  const t = S().tasks.find((x) => x.id === taskId);
  if (!t?.evidence?.some((x) => x.file === file) || !ATTACHMENT_NAME.test(file)) return;
  t.evidence = t.evidence.filter((x) => x.file !== file);
  fs.rmSync(path.join(S().projectDir!, '.office', 'evidence', file), { force: true });
  save();
}

export function sendToCoordinator(message: string, uploads: ImageUpload[] = []) {
  const s = S();
  if (!s.coordinator) throw err('err.noLead');
  if (!message && !uploads.length) return;
  if (uploads.length > MAX_CHAT_IMAGES) throw err('err.tooManyImages', { n: MAX_CHAT_IMAGES });
  const images = uploads.length ? saveImages(uploads) : [];
  log('boss', 'user', message, undefined, images);
  s.goal = message || T('imageOnlyGoal');
  s.goalSummarized = false;
  const officeRel = (n: string) => `.office/attachments/${n}`;
  enqueue('plan', 'lead', P.planPrompt(message, s.employees, s.tasks, images.map(officeRel)), undefined, images.map((n) => `attachments/${n}`));
  save();
}

export function grant(caps: Capability[], approvePending = true) {
  const s = S();
  s.granted = [...new Set([...s.granted, ...caps])];
  if (approvePending && s.pendingPermission) {
    const t = s.tasks.find((x) => x.id === s.pendingPermission!.taskId);
    if (t && t.status === 'needs_permission') t.status = 'todo';
    s.pendingPermission = undefined;
  }
  log('boss', 'user', T('granted', { caps: caps.join(', ') }));
  save();
  tick();
}

export function revoke(cap: Capability) {
  const s = S();
  s.granted = s.granted.filter((c) => c !== cap);
  save();
}

export function denyPending() {
  const s = S();
  if (!s.pendingPermission) return;
  const t = s.tasks.find((x) => x.id === s.pendingPermission!.taskId);
  if (t) {
    t.status = 'failed';
    t.reviewNote = T('denied');
  }
  s.pendingPermission = undefined;
  save();
}

export function updateSettings(patch: Partial<OfficeState['settings']>) {
  const s = S();
  s.settings = { ...s.settings, ...patch };
  save();
}

export function cancelJob(jobId: string) {
  const r = [...R().values()].find((x) => x.job.id === jobId);
  if (r) r.abort.abort();
  const j = S().jobs.find((x) => x.id === jobId);
  if (j && j.status !== 'running') j.status = 'failed';
  save();
}

export function retryTask(taskId: string) {
  const t = S().tasks.find((x) => x.id === taskId);
  if (t) {
    t.status = 'todo';
    save();
    tick();
  }
}

// ---------- jobs & scheduler ----------

function enqueue(kind: JobKind, employeeId: string, prompt: string, taskId?: string, images?: string[]) {
  const job: Job = { id: `J${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind, employeeId, taskId, prompt, ...(images?.length ? { images } : {}), status: 'queued', attempts: 0, createdAt: Date.now() };
  S().jobs.push(job);
  later(tick);
  return job;
}

function accountBlockedUntil(acc: Account | undefined): number | undefined {
  if (!acc?.coolingUntil) return undefined;
  return acc.coolingUntil > Date.now() ? acc.coolingUntil : undefined;
}

export function busyMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const c = activeId ? offices.get(activeId) : undefined;
  if (c) for (const [id, r] of c.running) out[id] = r.activity;
  return out;
}

export function tick() {
  const c = cx();
  if (c.ticking) return;
  c.ticking = true;
  const s = c.state;
  try {
    const now = Date.now();
    let changed = false;

    // 1) wake up jobs whose quota window has reset
    for (const j of s.jobs) {
      if (j.status === 'waiting_quota' && j.resumeAt && j.resumeAt <= now) {
        j.status = 'queued';
        const e = staff(j.employeeId);
        if (e) {
          setCooling(e.accountId, undefined);
          e.status = 'idle';
          log(e.id, 'speech', T('wake'), 'wake');
        }
        changed = true;
      }
    }

    // 2) materialize runnable tasks into execute jobs
    for (const t of s.tasks) {
      if (t.status !== 'todo') continue;
      if (s.jobs.some((j) => j.taskId === t.id && j.kind === 'execute' && (j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota'))) continue;
      if (!t.dependsOn.every((d) => s.tasks.find((x) => x.id === d)?.status === 'done')) continue;
      const missing = t.needs.filter((cap) => !s.granted.includes(cap) && !s.granted.includes('full_access'));
      if (missing.length) {
        if (!s.pendingPermission) {
          t.status = 'needs_permission';
          s.pendingPermission = { taskId: t.id, needs: missing, reason: T('needPermReason', { id: t.id, title: t.title, caps: missing.join(', ') }) };
          log('lead', 'speech', T('needPerm', { id: t.id, caps: missing.join(', ') }), 'perm');
          changed = true;
        }
        continue;
      }
      const e = staff(t.assigneeId);
      if (!e) {
        t.status = 'failed';
        t.reviewNote = T('assigneeGone');
        changed = true;
        continue;
      }
      // Reference images go with the first attempt only; revisions continue in a session that has already seen them.
      const imgs = t.reviewNote ? undefined : t.images;
      const officeAbs = path.join(s.projectDir!, '.office').split(path.sep).join('/');
      const prompt = P.executePrompt(t, {
        images: imgs?.map((n) => `${officeAbs}/attachments/${n}`),
        evidenceDir: ensureDir(path.join(s.projectDir!, '.office', 'evidence')),
        shotTool: SHOT_TOOL,
      });
      enqueue('execute', e.id, prompt, t.id, imgs?.map((n) => `attachments/${n}`));
      changed = true;
    }

    // 3) start queued jobs (one per employee, per-office parallel cap)
    for (const j of s.jobs) {
      if (j.status !== 'queued') continue;
      if (c.running.has(j.employeeId)) continue;
      if (c.running.size >= s.settings.maxParallel + 1) break; // +1: the lead always gets a seat
      const e = staff(j.employeeId);
      const acc = e && getAccount(e.accountId);
      if (!e || !acc) {
        j.status = 'failed';
        j.error = T('missingStaff');
        changed = true;
        continue;
      }
      const blocked = accountBlockedUntil(acc);
      if (blocked) {
        if (!failover(e, j)) parkForQuota(j, e, blocked);
        changed = true;
        continue;
      }
      void als.run(c, () => runJob(j, e, acc));
      changed = true;
    }

    // 4) all work for the current goal finished → the lead writes the final report
    if (s.goal && !s.goalSummarized && s.tasks.length) {
      const goalTasks = s.tasks.filter((t) => t.createdAt >= (s.goalAt ?? 0));
      const finished = goalTasks.length && goalTasks.every((t) => t.status === 'done' || t.status === 'failed');
      const idle = !s.jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_quota');
      if (finished && idle) {
        s.goalSummarized = true;
        enqueue('summary', 'lead', P.summaryPrompt(s.goal, goalTasks));
        changed = true;
      }
    }

    if (changed) save();
  } finally {
    c.ticking = false;
  }
}

/** Move the employee to another account with headroom (if the boss enabled failover). */
function failover(e: Employee, j: Job): boolean {
  const mode = S().settings.failover;
  if (mode === 'off') return false;
  const cur = getAccount(e.accountId);
  const next = getAccounts()
    .filter((a) => a.id !== e.accountId && a.loggedIn && !accountBlockedUntil(a))
    .filter((a) => mode === 'any' || a.provider === e.provider)
    .filter((a) => (a.usage?.fiveHour?.usedPercent ?? 0) < 90 && (a.usage?.weekly?.usedPercent ?? 0) < 95)
    .sort(
      (a, b) =>
        (a.provider === e.provider ? 0 : 1) - (b.provider === e.provider ? 0 : 1) ||
        (a.usage?.fiveHour?.usedPercent ?? 0) - (b.usage?.fiveHour?.usedPercent ?? 0),
    )[0];
  if (!next) return false;
  const tier = listModels()[e.provider].find((m) => m.id === e.model)?.tier ?? 'standard';
  if (next.provider !== e.provider) {
    e.provider = next.provider;
    e.model = pickModel(next.provider, tier === 'max' ? 'high' : tier).id;
  }
  e.accountId = next.id;
  e.sessionId = undefined; // sessions live in the old account's config dir; the notebook carries the memory
  e.sessionGeneration++;
  e.status = 'idle';
  e.statusText = undefined;
  j.status = 'queued';
  j.resumeAt = undefined;
  log(e.id, 'speech', T('failover', { from: cur?.label ?? '?', to: next.label }), 'failover');
  return true;
}

function parkForQuota(j: Job, e: Employee, resetsAt: number) {
  // +90s buffer so we don't hit the wall again right at the reset second.
  j.resumeAt = resetsAt + Number(process.env.NEXCANVAS_RESUME_BUFFER_MS ?? 90_000);
  j.status = 'waiting_quota';
  e.status = 'sleeping';
  const when = new Date(j.resumeAt).toLocaleString(LOCALE[lang()], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  e.statusText = T('sleepStatus', { when });
  if (j.taskId) {
    const t = S().tasks.find((x) => x.id === j.taskId);
    if (t) t.status = 'waiting_quota';
  }
  log(e.id, 'speech', T('sleep', { when }), 'sleep');
}

function jobLabel(j: Job) {
  return T(`job.${j.kind}`, { id: j.taskId ?? '' });
}

async function runJob(job: Job, e: Employee, acc: Account) {
  const c = cx();
  const s = c.state;
  const abort = new AbortController();
  c.running.set(e.id, { job, abort, activity: T('thinking') });
  job.status = 'running';
  job.attempts++;
  e.status = 'working';
  e.statusText = jobLabel(job);
  if (job.taskId && job.kind === 'execute') {
    const t = s.tasks.find((x) => x.id === job.taskId);
    if (t) {
      t.status = 'in_progress';
      t.updatedAt = Date.now();
    }
  }
  save();

  // Rotate an over-grown session: the employee's notebook carries the memory into a fresh one.
  if (e.sessionId && e.stats.contextTokens > s.settings.rotateAtTokens && !e.isCoordinator) {
    e.sessionId = undefined;
    e.sessionGeneration++;
    log(e.id, 'system', T('rotate'));
  }

  let cwd = s.projectDir!;
  let conflicts: string[] = [];
  try {
    cwd = workdirFor(e);
  } catch (x: any) {
    log('system', 'error', T('worktreeFail', { name: e.name, err: x.message }));
  }
  if (e.workdir && e.workdir !== cwd && e.sessionId && e.provider === 'claude') {
    // Claude sessions are bound to their folder: moving folders = new session (the notebook carries the memory).
    e.sessionId = undefined;
    e.sessionGeneration++;
  }
  e.workdir = cwd;
  if (job.kind === 'execute' && cwd !== s.projectDir && job.attempts === 1) {
    conflicts = G.syncFromMain(s.projectDir!, cwd).conflicts;
  }

  const officeAbs = path.join(s.projectDir!, '.office').split(path.sep).join('/');
  const parts: string[] = [];
  if (job.kind === 'execute') {
    if (conflicts.length) parts.push(P.conflictNote(conflicts));
    if (job.attempts > 1) parts.push(P.RESUME_NOTE);
    if (!e.sessionId) {
      // New session (first task, rotation or account switch): bootstrap from the brief + own notebook.
      const hasNotes = fs.existsSync(path.join(s.projectDir!, '.office', 'agents', `${e.id}.md`));
      parts.push(P.bootstrapNote(officeAbs, hasNotes ? `${officeAbs}/agents/${e.id}.md` : undefined));
    }
  }
  parts.push(job.prompt);

  const req = {
    account: acc,
    lang: s.language,
    cwd,
    // Workers in a worktree still need the shared office folder (brief + their notebook).
    // The lead gets the (constant) worktree root so it can open employees' files while reviewing.
    extraDirs: cwd !== s.projectDir ? [officeAbs] : e.isCoordinator && s.gitRepo ? [ensureDir(G.worktreeRoot(s.projectDir!))] : [],
    model: e.model,
    effort: e.effort,
    sessionId: e.sessionId,
    prompt: parts.join('\n\n'),
    images: officePaths(job.images),
    systemAppend: e.isCoordinator ? P.coordinatorCard(tpl(), s.language) : P.employeeCard(e, roleDuty(e.roleKey), officeAbs, s.language),
    schema: e.isCoordinator ? P.COORDINATOR_SCHEMA : P.REPORT_SCHEMA,
    granted: s.granted,
    // Lean = no MCP servers in the session (they add ~10k tokens of tool definitions per turn).
    lean: s.settings.leanMode,
    readOnly: e.isCoordinator,
    signal: abort.signal,
    onActivity: (text: string) => {
      const r = c.running.get(e.id);
      if (r) r.activity = text;
      bubble(c.id, e.id, text);
    },
    onUsage: (u: any) => {
      updateAccountUsage(acc.id, u);
      notify();
    },
  };

  let res: TurnResult;
  try {
    if (process.env.NEXCANVAS_SIMULATE_LIMIT && job.kind === 'execute' && !c.simulatedLimit) {
      // Dev aid: fake a usage-limit hit once (resets in N seconds) to exercise the sleep → resume path.
      c.simulatedLimit = true;
      const secs = Number(process.env.NEXCANVAS_SIMULATE_LIMIT) || 30;
      res = { ok: false, text: '', error: 'simulated usage limit', limited: { resetsAt: Date.now() + secs * 1000 }, usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
    } else {
      res = e.provider === 'claude' ? await runClaude(req) : await runCodex(req);
    }
  } catch (x: any) {
    res = { ok: false, text: '', error: x?.message ?? String(x), usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
  }
  c.running.delete(e.id);
  const pctCached = Math.round((100 * res.usage.cached) / Math.max(1, res.usage.cached + res.usage.input));
  console.log(
    `[turn] ${s.name.slice(0, 14).padEnd(14)} ${e.name.padEnd(12)} ${job.kind.padEnd(8)} new=${res.usage.input} cached=${res.usage.cached} (${pctCached}%) out=${res.usage.output} ok=${res.ok}${res.limited ? ' LIMITED' : ''}`,
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
    job.error = T('cancelled');
    log(e.id, 'info', T('stopped'));
  } else if (res.limited) {
    // The whole point: never give up on a task because of quota — sleep and resume the same session.
    const resetsAt = res.limited.resetsAt ?? acc.usage?.fiveHour?.resetsAt ?? Date.now() + 5 * 3600_000;
    setCooling(acc.id, resetsAt);
    job.status = 'queued';
    if (!failover(e, job)) parkForQuota(job, e, resetsAt);
    // Everyone else in this office on the same account is going to sleep too.
    for (const other of allStaff()) {
      if (other.id !== e.id && other.accountId === acc.id && !c.running.has(other.id)) {
        other.status = 'sleeping';
        other.statusText = e.statusText;
      }
    }
  } else if (!res.ok) {
    job.error = res.error;
    if (job.attempts < 3) {
      job.status = 'queued';
      log(e.id, 'error', T('retry', { n: job.attempts, err: String(res.error).slice(0, 160) }));
    } else {
      job.status = 'failed';
      log(e.id, 'error', T('failed', { err: String(res.error).slice(0, 200) }));
      if (job.taskId) {
        const t = s.tasks.find((x) => x.id === job.taskId);
        if (t) t.status = 'failed';
      }
      if (job.kind === 'analyze') s.phase = 'context';
    }
  } else {
    job.status = 'done';
    handleResult(job, e, res);
  }
  save();
  later(tick);
}

function handleResult(job: Job, e: Employee, res: TurnResult) {
  const s = S();
  const out = res.structured;
  switch (job.kind) {
    case 'analyze': {
      if (!out?.team) {
        log(e.id, 'error', T('badProposal'));
        s.phase = 'context';
        return;
      }
      const proposal: Proposal = {
        summary: out.summary ?? '',
        risks: out.risks ?? [],
        team: (out.team as any[]).slice(0, tpl().maxEmployees).map((r) => ({ ...r, skills: (r.skills ?? []).slice(0, 4) })),
      };
      s.proposal = proposal;
      if (out.brief_markdown && s.projectDir) fs.writeFileSync(path.join(s.projectDir, '.office', 'BRIEF.md'), out.brief_markdown);
      s.phase = 'proposal';
      log(e.id, 'speech', T('proposal', { summary: proposal.summary, n: proposal.team.length, roles: proposal.team.map((t) => t.title).join(', ') }));
      break;
    }
    case 'plan': {
      log(e.id, 'speech', out?.reply ?? res.text);
      const tasks = (out?.tasks ?? []) as any[];
      if (!tasks.length) return;
      s.goalAt = Date.now();
      const keyToId = new Map<string, string>();
      let n = s.tasks.length;
      for (const t of tasks) keyToId.set(t.key, `TASK-${String(++n).padStart(3, '0')}`);
      const validIds = new Set(s.employees.map((x) => x.id));
      for (const t of tasks) {
        const assignee = validIds.has(t.assignee) ? t.assignee : s.employees[0]?.id;
        if (!assignee) continue;
        s.tasks.push({
          id: keyToId.get(t.key)!,
          title: t.title,
          description: t.description,
          acceptance: t.acceptance,
          assigneeId: assignee,
          dependsOn: (t.dependsOn ?? []).map((k: string) => keyToId.get(k)).filter(Boolean),
          needs: (t.needs ?? []) as Capability[],
          status: 'todo',
          revisions: 0,
          ...(job.images?.length ? { images: job.images.map((r) => path.basename(r)) } : {}),
          goal: s.goal,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      log(e.id, 'info', T('assigned', { n: tasks.length }), 'plan');
      break;
    }
    case 'execute': {
      const t = s.tasks.find((x) => x.id === job.taskId);
      if (!t) return;
      const report: TaskReport = out?.summary ? out : { status: 'done', summary: res.text.slice(0, 600), files_changed: [], tests: '', blockers: '' };
      t.report = report;
      t.updatedAt = Date.now();
      try {
        collectEvidence(t, e, report);
      } catch (x: any) {
        log('system', 'error', `${t.id} evidence: ${x.message}`);
      }
      if (s.projectDir) fs.writeFileSync(path.join(s.projectDir, '.office', 'reports', `${t.id}.json`), JSON.stringify(report, null, 2));
      log(e.id, 'speech', T('done', { id: t.id, summary: report.summary.slice(0, 220) }), 'done');
      t.status = 'review';
      const wt = e.workdir && e.workdir !== s.projectDir ? e.workdir : undefined;
      const diff = wt ? G.reviewDiff(wt) : { stat: s.projectDir ? G.sharedDiffStat(s.projectDir) : '', patch: '' };
      // The lead looks at the evidence screenshots while reviewing (a few hundred to ~1.5k tokens each).
      const shots = (t.evidence ?? []).filter((x) => x.by === 'agent').slice(0, 3).map((x) => `evidence/${x.file}`);
      enqueue('review', 'lead', P.reviewPrompt(t, report, diff.stat, diff.patch, wt), t.id, shots);
      break;
    }
    case 'review': {
      const t = s.tasks.find((x) => x.id === job.taskId);
      if (!t) return;
      const verdict = out?.verdict ?? 'approve';
      t.updatedAt = Date.now();
      if (verdict === 'approve' || t.revisions >= s.settings.maxRevisions) {
        t.reviewNote = out?.feedback ?? undefined;
        if (!mergeTask(t)) return;
        t.status = 'done';
        t.doneAt = Date.now();
        log(e.id, 'speech', T('approved', { id: t.id, fb: out?.feedback ? `: ${String(out.feedback).slice(0, 160)}` : '' }), 'approve');
      } else {
        t.revisions++;
        t.reviewNote = out?.feedback;
        t.status = 'todo';
        log(e.id, 'speech', T('revise', { id: t.id, fb: String(out?.feedback ?? '').slice(0, 200) }), 'revise');
      }
      break;
    }
    case 'summary': {
      // Models often open with their own "Report:" heading — drop it, the UI already labels reports.
      const reply = String(out?.reply ?? res.text).replace(/^\s*(#+\s*)?\**\s*(Báo cáo|Report|报告|汇报)[^:：\n]*[:：]?\**\s*/i, '');
      log(e.id, 'speech', reply, 'report');
      if (s.projectDir) fs.writeFileSync(path.join(s.projectDir, '.office', 'reports', `summary-${Date.now()}.md`), reply);
      break;
    }
    default:
      log(e.id, 'speech', out?.reply ?? res.text);
  }
}

/** Merge the assignee's branch into main. On conflict the task goes back to the assignee. Returns true when done. */
function mergeTask(t: Task): boolean {
  const s = S();
  const worker = s.employees.find((x) => x.id === t.assigneeId);
  if (!worker?.workdir || !worker.branch || worker.workdir === s.projectDir || !s.projectDir) return true;
  const r = G.mergeIntoMain(s.projectDir, worker.workdir, worker.branch, `${t.id} ${t.title}`);
  if (r.ok) {
    t.merge = { status: 'merged', commit: r.commit };
    log('system', 'info', T('merged', { id: t.id, branch: s.mainBranch ?? 'main', commit: r.commit }), 'merge');
    return true;
  }
  if (r.conflicts.length && t.revisions < s.settings.maxRevisions + 2) {
    t.merge = { status: 'conflict', files: r.conflicts };
    t.revisions++;
    t.status = 'todo';
    t.reviewNote = T('conflictNote', { files: r.conflicts.join(', ') });
    log('lead', 'speech', T('conflict', { id: t.id, files: r.conflicts.join(', '), name: worker.name }), 'conflict');
    return false;
  }
  t.merge = { status: 'failed', note: r.ok ? '' : r.error ?? T('mergeFailedNote') };
  log('system', 'error', T('mergeFailed', { id: t.id, note: t.merge.note ?? '', branch: worker.branch }));
  return true;
}

export function startScheduler() {
  setInterval(() => {
    for (const c of offices.values()) als.run(c, tick);
  }, 5000);
  for (const c of offices.values()) als.run(c, tick);
}
