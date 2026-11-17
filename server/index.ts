import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { LANGS, type AppSnapshot, type Lang, type PastSession, type ServerEvent, type SkillInfo } from '../shared/types.ts';
import * as A from './accounts.ts';
import * as O from './office.ts';
import { EXPORT_PROMPTS, digestSession, findPastSessions } from './context.ts';
import { tr } from './i18n.ts';
import { listDir, pickFolder } from './fsdialog.ts';
import { scanSkills } from './skills.ts';
import { binExists } from './paths.ts';

const PORT = Number(process.env.NEXCANVAS_PORT || 4317);
const HOST = '127.0.0.1';
const WEB_DIST = fileURLToPath(new URL('../dist/web/', import.meta.url));

let skills: SkillInfo[] = [];
let skillsFor: string | undefined = 'init';
function currentSkills() {
  const dir = O.activeState()?.projectDir;
  if (skillsFor !== dir) {
    skills = scanSkills(dir);
    skillsFor = dir;
  }
  return skills;
}
const uiLang = (): Lang => O.activeState()?.language ?? O.getLanguage() ?? 'en';

/** Screen-sharing mode: never send account names or e-mails to the UI. */
const PRIVACY = /^(1|true|yes)$/i.test(process.env.NEXCANVAS_PRIVACY ?? '');

function snapshot(): AppSnapshot {
  const accounts = A.getAccounts().map((a) => (PRIVACY ? { ...a, email: undefined, displayName: undefined } : a));
  return {
    language: O.getLanguage(),
    office: O.activeState(),
    offices: O.listOffices(),
    templates: O.templateInfos(),
    accounts,
    models: A.listModels(),
    skills: currentSkills(),
    busy: O.busyMap(),
  };
}

// ---------- websocket ----------

const clients = new Set<WebSocket>();
function send(ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}
let pushTimer: NodeJS.Timeout | undefined;
function pushSnapshot() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    send({ type: 'snapshot', data: snapshot() });
  }, 120);
}
O.onChange(pushSnapshot);
O.onBubble((officeId, employeeId, text) => {
  send({ type: 'bubble', officeId, employeeId, text });
  pushSnapshot();
});

// ---------- http ----------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5317', 'localhost:5317']);

function isTrusted(req: http.IncomingMessage) {
  // Agents may run with write/exec permissions: refuse anything that isn't our own UI on loopback.
  if (!ALLOWED_HOSTS.has(String(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    // Collect raw bytes and decode once: a multi-byte UTF-8 char (Vietnamese!) may straddle two chunks.
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (size > 20 * 1024 * 1024) reject(new Error('Payload quá lớn'));
    });
    req.on('end', () => {
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data ?? null));
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.join(WEB_DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('UI chưa được build. Chạy "npm run dev" (dev) hoặc "npm start".');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

type Handler = (b: any, url: URL) => unknown | Promise<unknown>;
let pastSessionsCache: PastSession[] = [];

const routes: Record<string, Handler> = {
  'GET /api/snapshot': () => snapshot(),
  'GET /api/health': () => ({ claude: binExists('claude'), codex: binExists('codex') }),
  'GET /api/recent': () => O.recentProjects(),

  'POST /api/accounts/refresh': async () => {
    await A.refreshAccounts();
    pushSnapshot();
    return A.getAccounts();
  },
  'POST /api/accounts/add': async (b) => {
    const p = A.addProfile(b.provider, b.label);
    await A.refreshAccounts();
    const acc = A.getAccount(p.id)!;
    A.launchLogin(acc);
    pushSnapshot();
    return acc;
  },
  'POST /api/accounts/probe': async (b) => {
    const acc = A.getAccount(b.id);
    if (!acc) throw new Error(tr(uiLang(), 'err.noAccount', { id: b.id }));
    if (acc.provider === 'claude') await A.probeClaude(acc);
    else await A.refreshAccounts();
    pushSnapshot();
    return A.getAccount(b.id);
  },
  'POST /api/accounts/login': (b) => {
    const acc = A.getAccount(b.id);
    if (!acc) throw new Error(tr(uiLang(), 'err.noAccount', { id: b.id }));
    A.launchLogin(acc);
    return { ok: true };
  },
  'POST /api/accounts/remove': (b) => {
    if (O.accountInUse(b.id)) throw new Error(tr(uiLang(), 'err.accountInUse'));
    A.removeProfile(b.id);
    pushSnapshot();
    return { ok: true };
  },

  'POST /api/office/coordinator': (b) => O.chooseCoordinator(b),
  'POST /api/fs/pick': async (b) => ({ path: await pickFolder(b.title) }),
  'GET /api/fs/list': (_b, url) => listDir(url.searchParams.get('path') || undefined),
  'POST /api/office/folder': (b) => O.chooseFolder(b.path),

  'GET /api/context/sessions': () => {
    const dir = O.activeState()?.projectDir;
    if (!dir) return [];
    pastSessionsCache = findPastSessions(dir);
    return pastSessionsCache;
  },
  'POST /api/context/import': (b) => {
    const ids: string[] = b.ids ?? [];
    let total = 0;
    for (const s of pastSessionsCache.filter((x) => ids.includes(x.id))) {
      const text = digestSession(s);
      if (!text) continue;
      total += text.length;
      O.addContextFile(`session-${s.provider}-${s.id.slice(0, 8)}`, text);
    }
    return { chars: total };
  },
  'POST /api/context/upload': (b) => O.addContextFile(String(b.name || 'notes'), String(b.content || '')),
  'POST /api/context/remove': (b) => O.removeContextFile(b.name),
  'GET /api/context/export-prompt': () => ({ prompt: EXPORT_PROMPTS[uiLang()] }),

  'POST /api/office/analyze': (b) => O.startAnalysis(b.feedback),
  'POST /api/office/accept': () => O.acceptProposal(),
  'POST /api/office/add-staff': () => O.openStaffing(),
  'GET /api/office/staffing': () => O.suggestStaffing(),
  'POST /api/office/hire': (b) => O.hire(b.specs ?? []),

  'POST /api/lang': (b) => {
    if (!LANGS.includes(b.language)) throw new Error('bad language');
    O.setLanguage(b.language);
  },
  'POST /api/offices/create': (b) => ({ id: O.createOffice(b.type, b.name) }),
  'POST /api/offices/open': (b) => O.openOffice(b.id),
  'POST /api/offices/close': () => O.closeOffice(),
  'POST /api/offices/rename': (b) => O.renameOffice(b.id, String(b.name ?? '')),
  'POST /api/offices/delete': (b) => O.deleteOffice(b.id),

  'POST /api/employee/update': (b) => O.updateEmployee(b.id, b.patch ?? {}),
  'POST /api/employee/fire': (b) => O.fire(b.id),
  'POST /api/employee/reset-session': (b) => O.resetSession(b.id),

  'POST /api/chat': (b) => O.sendToCoordinator(String(b.message ?? '').trim()),
  'POST /api/permissions/grant': (b) => O.grant(b.caps ?? []),
  'POST /api/permissions/revoke': (b) => O.revoke(b.cap),
  'POST /api/permissions/deny': () => O.denyPending(),
  'POST /api/settings': (b) => O.updateSettings(b ?? {}),
  'POST /api/job/cancel': (b) => O.cancelJob(b.id),
  'POST /api/task/retry': (b) => O.retryTask(b.id),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  if (!isTrusted(req)) return json(res, 403, { error: 'forbidden' });
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    const b = req.method === 'POST' ? await body(req) : {};
    const out = await handler(b, url);
    json(res, 200, out ?? { ok: true });
  } catch (e: any) {
    json(res, 400, { error: e?.message ?? String(e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!isTrusted(req) || !req.url?.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() } satisfies ServerEvent));
    ws.on('close', () => clients.delete(ws));
  });
});

// ---------- boot ----------

O.loadAll();
await A.refreshAccounts();
O.startScheduler();
// Accounts/usage are re-read periodically (cheap: local files + `auth status`).
setInterval(() => A.refreshAccounts().then(pushSnapshot).catch(() => {}), 90_000);

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  🏢 NexCanvas Agent Manager → ${url}\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
  }
});
