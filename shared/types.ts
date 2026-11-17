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
  files_changed: string[];
  tests: string;
  blockers: string;
}

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

export interface LogEntry {
  at: number;
  who: string;
  kind: 'info' | 'speech' | 'tool' | 'error' | 'user' | 'system';
  text: string;
}

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

export interface OfficeState {
  version: 1;
  template: string;
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
}

export interface AppSnapshot {
  office: OfficeState;
  accounts: Account[];
  models: Record<Provider, ModelOption[]>;
  skills: SkillInfo[];
  busy: Record<string, string>;
}

export type ServerEvent =
  | { type: 'snapshot'; data: AppSnapshot }
  | { type: 'bubble'; employeeId: string; text: string };
