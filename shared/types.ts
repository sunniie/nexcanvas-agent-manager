// Shared domain types between the local server and the web UI.

export type Provider = 'claude' | 'codex';

export interface UsageWindow {
  /** 0-100 */
  usedPercent: number;
  /** epoch ms when this window resets */
  resetsAt?: number;
  status?: 'allowed' | 'warning' | 'rejected';
}

export interface Usage {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  updatedAt: number;
  source: 'cache' | 'live' | 'session-file';
}

/** A login "badge": one provider account living in its own config dir. */
export interface Account {
  id: string;
  provider: Provider;
  label: string;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME. Empty string = provider default. */
  configDir: string;
  isDefault: boolean;
  loggedIn: boolean;
  email?: string;
  displayName?: string;
  plan?: string;
  usage?: Usage;
  /** When the account is cooling down after hitting a limit (epoch ms). */
  coolingUntil?: number;
  /** Free "full reset" credits the provider granted (Codex) — shown as potions. */
  resetCredits?: { count: number; title?: string; expiresAt?: number };
  color: string;
}

export interface ModelOption {
  id: string;
  label: string;
  tier: 'max' | 'high' | 'standard' | 'light';
  efforts: string[];
}

export type EmployeeStatus = 'walking-in' | 'idle' | 'working' | 'sleeping' | 'blocked' | 'meeting';

export interface EmployeeStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** Size of the last prompt context — used to decide session rotation. */
  contextTokens: number;
}

export interface Employee {
  id: string;
  name: string;
  roleKey: string;
  title: string;
  isCoordinator: boolean;
  provider: Provider;
  accountId: string;
  model: string;
  effort: string;
  skills: string[];
  /** Persistent CLI session; resumed on every turn so the employee keeps its memory. */
  sessionId?: string;
  /** How many times the session was rotated (handed over via notes). */
  sessionGeneration: number;
  /** Folder the employee's CLI session is bound to (project dir or its git worktree). */
  workdir?: string;
  branch?: string;
  status: EmployeeStatus;
  statusText?: string;
  desk: number;
  look: { skin: string; hair: string; shirt: string; pants: string; hairStyle: number };
  stats: EmployeeStats;
}

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'waiting_quota'
  | 'needs_permission'
  | 'done'
  | 'failed';

export interface TaskReport {
  status: 'done' | 'partial' | 'blocked';
  summary: string;
  /** One or two plain sentences for the boss: what is different now. */
  result?: string;
  files_changed: string[];
  tests: string;
  blockers: string;
  /** Screenshots the employee saved as proof (paths as reported). */
  evidence?: { path: string; caption: string }[];
}

/** A proof image pinned to a finished task (file name in .office/evidence). */
export interface Evidence {
  file: string;
  caption: string;
  by: 'agent' | 'boss';
  at: number;
}
export const MAX_EVIDENCE = 6;

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  assigneeId: string;
  dependsOn: string[];
  needs: Capability[];
  status: TaskStatus;
  revisions: number;
  report?: TaskReport;
  reviewNote?: string;
  merge?: { status: 'merged' | 'conflict' | 'failed'; commit?: string; files?: string[]; note?: string };
  /** Reference images from the boss (file names in .office/attachments), inherited from the request. */
  images?: string[];
  /** Proof images for the report board. */
  evidence?: Evidence[];
  /** The boss's request this task came from. */
  goal?: string;
  doneAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type Capability = 'git_commit' | 'git_push' | 'install_deps' | 'deploy' | 'network' | 'full_access';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  git_commit: 'Commit git',
  git_push: 'Push lên remote',
  install_deps: 'Cài thư viện (npm/pip...)',
  deploy: 'Deploy',
  network: 'Truy cập mạng',
  full_access: 'Toàn quyền (bỏ sandbox)',
};

export type JobKind = 'analyze' | 'plan' | 'execute' | 'review' | 'summary' | 'chat';
export type JobStatus = 'queued' | 'running' | 'waiting_quota' | 'done' | 'failed';

/** Every model call is a job, so anything interrupted by a usage limit can be retried later. */
export interface Job {
  id: string;
  kind: JobKind;
  employeeId: string;
  taskId?: string;
  prompt: string;
  /** Images attached to this turn, as paths relative to the .office folder (e.g. "attachments/x.png"). */
  images?: string[];
  status: JobStatus;
  resumeAt?: number;
  attempts: number;
  error?: string;
  createdAt: number;
}

export interface TeamProposalRole {
  roleKey: string;
  title: string;
  why: string;
  modelTier: 'high' | 'standard' | 'light';
  skills: string[];
}

export interface Proposal {
  summary: string;
  team: TeamProposalRole[];
  risks: string[];
}

export type Phase =
  | 'choose-coordinator'
  | 'choose-folder'
  | 'context'
  | 'analyzing'
  | 'proposal'
  | 'staffing'
  | 'ready';

export type LogTag = 'report' | 'done' | 'merge' | 'conflict' | 'sleep' | 'wake' | 'failover' | 'plan' | 'approve' | 'revise' | 'perm';

export interface LogEntry {
  at: number;
  /** Speaker id: an employee id ('lead' = the coordinator), 'system' or 'boss'. */
  who: string;
  kind: 'info' | 'speech' | 'tool' | 'error' | 'user' | 'system';
  text: string;
  tag?: LogTag;
  /** Images the boss attached (file names in .office/attachments). */
  images?: string[];
}

/** An image pasted or dropped into the chat, sent as a data URL. */
export interface ImageUpload {
  name?: string;
  data: string;
}
export const MAX_CHAT_IMAGES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface Settings {
  /** Strip MCP servers / user settings from worker sessions to save context tokens. */
  leanMode: boolean;
  maxParallel: number;
  /** Rotate a session (hand over through notes) once its context grows past this. */
  rotateAtTokens: number;
  maxRevisions: number;
  /** auto = own git worktree per employee when the project is a git repo and the team has >1 person. */
  isolation: 'auto' | 'worktree' | 'shared';
  /** On a usage limit: wait for the reset (off) or move the employee to another account with quota. */
  failover: 'off' | 'same' | 'any';
}

export type Lang = 'en' | 'vi' | 'zh';
export const LANGS: Lang[] = ['en', 'vi', 'zh'];
export type OfficeType = 'code' | 'video' | 'other';
export const MAX_OFFICES = 6;

export interface OfficeState {
  version: 1;
  id: string;
  name: string;
  /** Office template id (code | video | other). */
  template: OfficeType;
  /** Language the agents write in (fixed when the office is created). */
  language: Lang;
  createdAt: number;
  phase: Phase;
  projectDir?: string;
  contextFiles: string[];
  coordinator?: Employee;
  employees: Employee[];
  tasks: Task[];
  jobs: Job[];
  proposal?: Proposal;
  granted: Capability[];
  pendingPermission?: { taskId: string; needs: Capability[]; reason: string };
  goal?: string;
  gitRepo?: boolean;
  mainBranch?: string;
  goalAt?: number;
  goalSummarized?: boolean;
  settings: Settings;
  log: LogEntry[];
}

export interface SkillInfo {
  name: string;
  description: string;
  provider: Provider | 'both';
  source: string;
}

export interface PastSession {
  provider: Provider;
  id: string;
  file: string;
  startedAt: number;
  updatedAt: number;
  title: string;
  messages: number;
  /** Set when the session was started in a parent folder (and worked on this one) or in a subfolder. */
  origin?: 'parent' | 'child';
  /** Name of that other folder, for display. */
  originDir?: string;
}

export interface OfficeSummary {
  id: string;
  name: string;
  template: OfficeType;
  projectDir?: string;
  mainBranch?: string;
  phase: Phase;
  employees: number;
  working: number;
  sleeping: number;
  openTasks: number;
  doneTasks: number;
  createdAt: number;
}

export interface TemplateText {
  name: string;
  tagline: string;
  description: string;
  can: string[];
  cannot: string[];
}

export interface TemplateInfo {
  id: OfficeType;
  icon: string;
  /** Not available yet: shown in the lobby behind a lock. */
  locked?: boolean;
  maxEmployees: number;
  i18n: Record<Lang, TemplateText>;
}

export interface AppSnapshot {
  /** UI language; undefined until the user picks one on first launch. */
  language?: Lang;
  /** The open office; undefined = lobby. */
  office?: OfficeState;
  offices: OfficeSummary[];
  templates: TemplateInfo[];
  accounts: Account[];
  models: Record<Provider, ModelOption[]>;
  skills: SkillInfo[];
  busy: Record<string, string>;
}

export type ServerEvent =
  | { type: 'snapshot'; data: AppSnapshot }
  | { type: 'bubble'; officeId: string; employeeId: string; text: string };
