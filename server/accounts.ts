import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { Account, ModelOption, Provider, Usage } from '../shared/types.ts';
import {
  APP_CONFIG,
  DEFAULT_CLAUDE_DIR,
  DEFAULT_CODEX_DIR,
  PROFILES_DIR,
  claudeStatePath,
  readJson,
  resolveBin,
  writeJson,
} from './paths.ts';

interface StoredProfile {
  id: string;
  provider: Provider;
  label: string;
  configDir: string;
}

const BADGE_COLORS = ['#e8a33d', '#4fb3ff', '#b67cff', '#5fd47a', '#ff6f91', '#f2e85c', '#4fe0d0', '#ff8a4c'];

let accounts: Account[] = [];

function storedProfiles(): StoredProfile[] {
  return readJson<{ profiles?: StoredProfile[] }>(APP_CONFIG, {}).profiles ?? [];
}

function saveProfiles(profiles: StoredProfile[]) {
  const cfg = readJson<Record<string, unknown>>(APP_CONFIG, {});
  writeJson(APP_CONFIG, { ...cfg, profiles });
}

export function getAccounts() {
  return accounts;
}

export function getAccount(id: string) {
  return accounts.find((a) => a.id === id);
}

/** Env vars that point a CLI at the account's own config dir. */
export function accountEnv(acc: Account): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (acc.configDir) {
    if (acc.provider === 'claude') env.CLAUDE_CONFIG_DIR = acc.configDir;
    else env.CODEX_HOME = acc.configDir;
  }
  return env;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 20000, windowsHide: true }, (_err, stdout) => resolve(stdout || ''));
  });
}

// ---------- Claude ----------

function claudeUsageFromCache(state: any): Usage | undefined {
  const u = state?.cachedUsageUtilization;
  if (!u?.utilization) return undefined;
  const w = (x: any) =>
    x
      ? {
          usedPercent: Math.round(Number(x.utilization ?? 0)),
          resetsAt: x.resets_at ? Date.parse(x.resets_at) : undefined,
        }
      : undefined;
  return {
    fiveHour: w(u.utilization.five_hour),
    weekly: w(u.utilization.seven_day),
    updatedAt: u.fetchedAtMs ?? Date.now(),
    source: 'cache',
  };
}

function newest(a?: Usage, b?: Usage) {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

async function detectClaude(acc: Account): Promise<Account> {
  const out = await run(resolveBin('claude'), ['auth', 'status', '--json'], accountEnv(acc));
  let status: any = {};
  try {
    status = JSON.parse(out);
  } catch {
    /* not logged in or CLI missing */
  }
  const state = readJson<any>(claudeStatePath(acc.configDir), {});
  const oauth = state.oauthAccount ?? {};
  return {
    ...acc,
    loggedIn: !!status.loggedIn,
    email: status.email ?? oauth.emailAddress,
    displayName: oauth.displayName,
    plan: status.subscriptionType ?? oauth.organizationType,
    usage: newest(acc.usage, claudeUsageFromCache(state)),
  };
}

// ---------- Codex ----------

function decodeJwt(token: string): any {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Newest rollout files first (sessions/YYYY/MM/DD/rollout-*.jsonl). */
export function codexRolloutFiles(codexHome: string, limit = 40): string[] {
  const root = path.join(codexHome, 'sessions');
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Codex writes `rate_limits` into every token_count event of the session file. */
export function codexUsageFromFile(file: string): Usage | undefined {
  let text = '';
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const size = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return undefined;
  }
  const idx = text.lastIndexOf('"rate_limits":{');
  if (idx < 0) return undefined;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const lineEnd = text.indexOf('\n', idx);
  try {
    const line = JSON.parse(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd));
    const rl = findKey(line, 'rate_limits');
    if (!rl) return undefined;
    const w = (x: any) =>
      x
        ? {
            usedPercent: Math.round(Number(x.used_percent ?? 0)),
            resetsAt: x.resets_at ? Number(x.resets_at) * 1000 : undefined,
            status: (Number(x.used_percent) >= 100 ? 'rejected' : 'allowed') as 'rejected' | 'allowed',
          }
        : undefined;
    // primary = 5h window (300 min), secondary = weekly (10080 min)
    const windows = [rl.primary, rl.secondary].filter(Boolean);
    const five = windows.find((x: any) => x.window_minutes <= 360);
    const week = windows.find((x: any) => x.window_minutes > 360);
    const mtime = fs.statSync(file).mtimeMs;
    return { fiveHour: w(five), weekly: w(week), updatedAt: mtime, source: 'session-file' };
  } catch {
    return undefined;
  }
}

/** Prompt size of the most recent model call in a Codex session (`last_token_usage.input_tokens`). */
export function codexLastContext(file: string): number | undefined {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const m = [...text.matchAll(/"last_token_usage":\{"input_tokens":(\d+)/g)].pop();
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

function findKey(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r) return r;
  }
  return undefined;
}

/** A window whose reset time already passed is effectively back to 0%. */
function expireWindows(u?: Usage): Usage | undefined {
  if (!u) return u;
  const now = Date.now();
  const fix = (w?: Usage['fiveHour']) =>
    w && w.resetsAt && w.resetsAt < now ? { ...w, usedPercent: 0, status: 'allowed' as const } : w;
  return { ...u, fiveHour: fix(u.fiveHour), weekly: fix(u.weekly) };
}

async function detectCodex(acc: Account): Promise<Account> {
  const home = acc.configDir || DEFAULT_CODEX_DIR;
  const auth = readJson<any>(path.join(home, 'auth.json'), null);
  const claims = auth?.tokens?.id_token ? decodeJwt(auth.tokens.id_token) : {};
  const authInfo = claims['https://api.openai.com/auth'] ?? {};
  const accountId = auth?.tokens?.account_id;
  let usage: Usage | undefined;
  for (const f of codexRolloutFiles(home, 15)) {
    // Skip sessions created by a different ChatGPT account in the same CODEX_HOME.
    if (accountId) {
      try {
        const head = fs.readFileSync(f, { encoding: 'utf8' }).slice(0, 2000);
        if (head.includes('creator_account_id') && !head.includes(accountId)) continue;
      } catch {
        continue;
      }
    }
    usage = codexUsageFromFile(f);
    if (usage) break;
  }
  const loggedIn = !!(auth?.tokens || auth?.OPENAI_API_KEY);
  const live = loggedIn ? await codexLive(acc) : undefined;
  if (live?.usage) usage = live.usage;
  return {
    ...acc,
    loggedIn,
    resetCredits: live?.resetCredits ?? acc.resetCredits,
    email: claims.email,
    displayName: claims.name,
    plan: authInfo.chatgpt_plan_type ?? (auth?.OPENAI_API_KEY ? 'api-key' : undefined),
    usage: acc.usage?.source === 'live' && acc.usage.updatedAt > (usage?.updatedAt ?? 0) ? acc.usage : usage,
  };
}

/**
 * Ask `codex app-server` (the JSON-RPC backend of the Codex IDE extension) for live rate limits.
 * Costs zero model tokens. Also returns free "full reset" credits, shown as potions in the UI.
 */
function codexLive(acc: Account): Promise<{ usage?: Usage; resetCredits?: Account['resetCredits'] } | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(resolveBin('codex'), ['app-server'], { env: accountEnv(acc), windowsHide: true });
    const finish = (v: Awaited<ReturnType<typeof codexLive>>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), 15000);
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          const r = msg.result;
          if (!r?.rateLimits) return finish(undefined);
          const w = (x: any) =>
            x ? { usedPercent: Math.round(x.usedPercent ?? 0), resetsAt: x.resetsAt ? x.resetsAt * 1000 : undefined, status: (x.usedPercent >= 100 ? 'rejected' : 'allowed') as 'rejected' | 'allowed' } : undefined;
          const wins = [r.rateLimits.primary, r.rateLimits.secondary].filter(Boolean);
          const credits = (r.rateLimitResetCredits?.credits ?? []).filter((c: any) => c.status === 'available');
          finish({
            usage: {
              fiveHour: w(wins.find((x: any) => x.windowDurationMins <= 360)),
              weekly: w(wins.find((x: any) => x.windowDurationMins > 360)),
              updatedAt: Date.now(),
              source: 'live',
            },
            resetCredits: {
              count: r.rateLimitResetCredits?.availableCount ?? credits.length,
              title: credits[0]?.title,
              expiresAt: credits[0]?.expiresAt ? credits[0].expiresAt * 1000 : undefined,
            },
          });
        }
      }
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(undefined));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nexcanvas', version: '0.1.0' } } });
  });
}

/**
 * Claude has no zero-cost usage query we can use, so this runs the smallest possible turn (Haiku, no tools,
 * no session) and reads the `rate_limit_event` it emits. Only runs when the user presses "Đo".
 */
export function probeClaude(acc: Account): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      resolveBin('claude'),
      ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--tools', ''],
      { env: accountEnv(acc), windowsHide: true, cwd: PROFILES_DIR },
    );
    let buf = '';
    let got = false;
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'rate_limit_event') {
            const w = ev.rate_limit_info?.unifiedWindows ?? {};
            const conv = (x: any) => (x ? { usedPercent: Math.round(x.utilization <= 1 ? x.utilization * 100 : x.utilization), resetsAt: x.resetsAt ? x.resetsAt * 1000 : undefined, status: x.status } : undefined);
            updateAccountUsage(acc.id, { fiveHour: conv(w.five_hour), weekly: conv(w.seven_day) });
            got = true;
          }
        } catch {
          /* ignore */
        }
      }
    });
    child.on('close', () => resolve(got));
    child.on('error', () => resolve(false));
    child.stdin.end('Reply with: ok');
  });
}

// ---------- registry ----------

export async function refreshAccounts(): Promise<Account[]> {
  const base: Account[] = [
    { id: 'claude-default', provider: 'claude', label: 'Claude', configDir: '', isDefault: true, loggedIn: false, color: BADGE_COLORS[0] },
    { id: 'codex-default', provider: 'codex', label: 'Codex', configDir: '', isDefault: true, loggedIn: false, color: BADGE_COLORS[1] },
    ...storedProfiles().map((p, i) => ({
      ...p,
      isDefault: false,
      loggedIn: false,
      color: BADGE_COLORS[(i + 2) % BADGE_COLORS.length],
    })),
  ];
  const prev = new Map(accounts.map((a) => [a.id, a]));
  accounts = await Promise.all(
    base.map(async (a) => {
      const saved = prev.has(a.id) ? {} : savedUsage(a.id);
      const merged = { ...a, usage: prev.get(a.id)?.usage ?? saved.usage, coolingUntil: prev.get(a.id)?.coolingUntil ?? saved.coolingUntil };
      const detected = a.provider === 'claude' ? await detectClaude(merged) : await detectCodex(merged);
      return { ...detected, usage: expireWindows(detected.usage) };
    }),
  );
  return accounts;
}

export function updateAccountUsage(id: string, patch: Partial<Usage>) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.usage = { ...(acc.usage ?? { updatedAt: Date.now(), source: 'live' }), ...patch, updatedAt: Date.now(), source: 'live' };
  persistUsage();
}

// Live readings (from rate_limit_event during runs) survive restarts; otherwise Claude would fall back
// to the CLI's own cache, which is only refreshed when the user opens /usage.
const USAGE_FILE = path.join(PROFILES_DIR, '..', 'usage-cache.json');
let persistTimer: NodeJS.Timeout | undefined;
function persistUsage() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out: Record<string, { usage?: Usage; coolingUntil?: number }> = {};
    for (const a of accounts) out[a.id] = { usage: a.usage, coolingUntil: a.coolingUntil };
    writeJson(USAGE_FILE, out);
  }, 500);
}
function savedUsage(id: string): { usage?: Usage; coolingUntil?: number } {
  return readJson<Record<string, any>>(USAGE_FILE, {})[id] ?? {};
}

export function setCooling(id: string, until?: number) {
  const acc = accounts.find((a) => a.id === id);
  if (acc) acc.coolingUntil = until;
  persistUsage();
}

export function addProfile(provider: Provider, label: string): StoredProfile {
  const profiles = storedProfiles();
  const n = profiles.filter((p) => p.provider === provider).length + 2;
  const id = `${provider}-${n}-${Date.now().toString(36).slice(-4)}`;
  const configDir = path.join(PROFILES_DIR, id);
  fs.mkdirSync(configDir, { recursive: true });
  const profile = { id, provider, label: label || `${provider === 'claude' ? 'Claude' : 'Codex'} #${n}`, configDir };
  saveProfiles([...profiles, profile]);
  return profile;
}

export function removeProfile(id: string) {
  saveProfiles(storedProfiles().filter((p) => p.id !== id));
  accounts = accounts.filter((a) => a.id !== id);
}

/** Opens a real terminal window running the provider's login flow for this profile. */
export function launchLogin(acc: Account) {
  const bin = acc.provider === 'claude' ? 'claude' : 'codex';
  const loginArgs = acc.provider === 'claude' ? 'auth login' : 'login';
  const envName = acc.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const dir = acc.configDir || (acc.provider === 'claude' ? DEFAULT_CLAUDE_DIR : DEFAULT_CODEX_DIR);
  if (process.platform === 'win32') {
    const setEnv = acc.configDir ? `set "${envName}=${dir}" && ` : '';
    spawn('cmd.exe', ['/c', 'start', '"NexCanvas login"', 'cmd', '/k', `${setEnv}${bin} ${loginArgs}`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
  } else if (process.platform === 'darwin') {
    const setEnv = acc.configDir ? `export ${envName}='${dir}'; ` : '';
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${setEnv}${bin} ${loginArgs}"`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const setEnv = acc.configDir ? `export ${envName}='${dir}'; ` : '';
    spawn('x-terminal-emulator', ['-e', `bash -lc "${setEnv}${bin} ${loginArgs}; exec bash"`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------- models ----------

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function listModels(): Record<Provider, ModelOption[]> {
  const claude: ModelOption[] = [
    { id: 'opus', label: 'Opus (mạnh)', tier: 'high', efforts: CLAUDE_EFFORTS },
    { id: 'sonnet', label: 'Sonnet (cân bằng)', tier: 'standard', efforts: CLAUDE_EFFORTS },
    { id: 'haiku', label: 'Haiku (nhanh, rẻ)', tier: 'light', efforts: CLAUDE_EFFORTS },
  ];
  const state = readJson<any>(claudeStatePath(''), {});
  for (const m of state.additionalModelOptionsCache ?? []) {
    if (m?.value && !claude.some((c) => c.id === m.value)) {
      claude.unshift({ id: m.value, label: `${m.label} (cao cấp nhất)`, tier: 'max', efforts: CLAUDE_EFFORTS });
    }
  }

  const cache = readJson<any>(path.join(DEFAULT_CODEX_DIR, 'models_cache.json'), {});
  const codex: ModelOption[] = (cache.models ?? [])
    .filter((m: any) => m.visibility !== 'hide')
    .map((m: any, i: number) => ({
      id: m.slug,
      label: m.display_name ?? m.slug,
      tier: i === 0 ? 'high' : /luna|mini/i.test(m.slug) ? 'light' : 'standard',
      efforts: (m.supported_reasoning_levels ?? []).map((r: any) => r.effort ?? r),
    }));
  if (!codex.length) {
    const cfg = (() => {
      try {
        return fs.readFileSync(path.join(DEFAULT_CODEX_DIR, 'config.toml'), 'utf8');
      } catch {
        return '';
      }
    })();
    const m = /^model\s*=\s*"([^"]+)"/m.exec(cfg)?.[1] ?? 'default';
    codex.push({ id: m, label: m, tier: 'high', efforts: ['low', 'medium', 'high'] });
  }
  return { claude, codex };
}

export function pickModel(provider: Provider, tier: 'high' | 'standard' | 'light'): ModelOption {
  const list = listModels()[provider];
  return list.find((m) => m.tier === tier) ?? list.find((m) => m.tier === 'high') ?? list[0];
}
