import { spawn } from 'node:child_process';
import type { Capability } from '../../shared/types.ts';
import { accountEnv } from '../accounts.ts';
import { resolveBin } from '../paths.ts';
import { LIMIT_PATTERN, extractJson, parseResetHint, shortPath, type TurnRequest, type TurnResult } from './types.ts';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(ls:*)'];

/** The coordinator may not edit, but it may run the test suite to verify a worker's claim during review. */
// Glob form ("test*"), not prefix form ("test:*"): the prefix form needs a space after the word,
// so `Bash(node test:*)` would NOT match `node test.js`.
const REVIEW_TOOLS = [
  'Bash(npm test*)', 'Bash(npm run test*)', 'Bash(pnpm test*)', 'Bash(pnpm run test*)', 'Bash(yarn test*)',
  'Bash(node test*)', 'Bash(node --test*)', 'Bash(npx vitest*)', 'Bash(npx jest*)',
  'Bash(pytest*)', 'Bash(python -m pytest*)', 'Bash(go test*)', 'Bash(cargo test*)',
];

const WORK_TOOLS = [
  ...READ_TOOLS,
  'Edit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(npx:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm run:*)',
  'Bash(yarn test:*)',
  'Bash(node:*)',
  'Bash(python:*)',
  'Bash(pytest:*)',
  'Bash(go test:*)',
  'Bash(cargo test:*)',
  'Bash(cargo build:*)',
  'Bash(mkdir:*)',
  'Bash(cat:*)',
];

const CAPABILITY_TOOLS: Record<Capability, string[]> = {
  git_commit: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git branch:*)'],
  git_push: ['Bash(git push:*)', 'Bash(gh pr:*)'],
  install_deps: ['Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(pnpm add:*)', 'Bash(pnpm install:*)', 'Bash(yarn add:*)', 'Bash(pip install:*)'],
  deploy: ['Bash(vercel:*)', 'Bash(netlify:*)', 'Bash(firebase deploy:*)', 'Bash(npm run deploy:*)', 'Bash(wrangler:*)'],
  network: ['WebFetch', 'WebSearch', 'Bash(curl:*)'],
  full_access: [],
};

function permissionArgs(req: TurnRequest): string[] {
  if (req.readOnly) {
    return ['--permission-mode', 'default', '--allowedTools', ...READ_TOOLS, ...REVIEW_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit'];
  }
  if (req.granted.includes('full_access')) return ['--dangerously-skip-permissions'];
  const tools = [...WORK_TOOLS, ...req.granted.flatMap((c) => CAPABILITY_TOOLS[c] ?? [])];
  return ['--permission-mode', 'acceptEdits', '--allowedTools', ...tools];
}

function describeTool(name: string, input: any): string {
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ ${name === 'Write' ? 'Tạo' : 'Sửa'} ${shortPath(input?.file_path ?? input?.notebook_path)}`;
    case 'Read':
      return `📖 Đọc ${shortPath(input?.file_path)}`;
    case 'Bash':
    case 'PowerShell':
      return `⌨️ ${String(input?.command ?? '').slice(0, 60)}`;
    case 'Grep':
    case 'Glob':
      return `🔎 Tìm ${String(input?.pattern ?? '').slice(0, 40)}`;
    case 'TodoWrite':
      return '📝 Cập nhật checklist';
    case 'WebSearch':
    case 'WebFetch':
      return '🌐 Tra cứu web';
    case 'Agent':
    case 'Task':
      return '🤝 Gọi trợ lý phụ';
    default:
      return `🔧 ${name}`;
  }
}

const pct = (v: any) => (v == null ? undefined : Math.round(Number(v) <= 1 ? Number(v) * 100 : Number(v)));

export function runClaude(req: TurnRequest): Promise<TurnResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', req.model];
  if (req.effort) args.push('--effort', req.effort);
  if (req.sessionId) args.push('--resume', req.sessionId);
  if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend);
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
  for (const d of req.extraDirs ?? []) args.push('--add-dir', d);
  // Keep the system prompt byte-identical across turns (git status/cwd move into the first user message),
  // otherwise every edit a worker makes would invalidate the coordinator's prompt cache.
  args.push('--exclude-dynamic-system-prompt-sections');
  if (req.lean) args.push('--strict-mcp-config');
  args.push(...permissionArgs(req));

  return new Promise((resolve) => {
    const child = spawn(resolveBin('claude'), args, {
      cwd: req.cwd,
      env: accountEnv(req.account),
      windowsHide: true,
      signal: req.signal,
    });
    const result: TurnResult = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
    let buf = '';
    let stderr = '';
    let lastText = '';

    const handle = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id) result.sessionId = ev.session_id;
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') req.onActivity?.(describeTool(block.name, block.input));
          else if (block.type === 'text' && block.text?.trim()) lastText = block.text.trim();
        }
        const u = ev.message?.usage;
        if (u) {
          result.usage.contextTokens =
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
      } else if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info ?? {};
        const w = info.unifiedWindows ?? {};
        const conv = (x: any) =>
          x ? { usedPercent: pct(x.utilization) ?? 0, resetsAt: x.resetsAt ? x.resetsAt * 1000 : undefined, status: x.status } : undefined;
        req.onUsage?.({ fiveHour: conv(w.five_hour), weekly: conv(w.seven_day) });
        if (info.status === 'rejected') result.limited = { resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined };
      } else if (ev.type === 'result') {
        result.ok = !ev.is_error && ev.subtype === 'success';
        result.text = typeof ev.result === 'string' ? ev.result : lastText;
        result.costUsd = ev.total_cost_usd ?? 0;
        const u = ev.usage ?? {};
        result.usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        result.usage.cached = u.cache_read_input_tokens ?? 0;
        result.usage.output = u.output_tokens ?? 0;
        if (req.schema) result.structured = ev.structured_output ?? extractJson(result.text);
        if (!result.ok) result.error = result.text || ev.subtype;
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      result.error = err.message;
    });
    child.on('close', () => {
      if (buf.trim()) handle(buf);
      if (!result.ok && !result.error) result.error = stderr.trim().slice(-500) || 'Claude exited without a result';
      const errText = `${result.error ?? ''} ${stderr}`;
      if (!result.ok && !result.limited && LIMIT_PATTERN.test(errText)) {
        result.limited = { resetsAt: parseResetHint(errText) };
      }
      resolve(result);
    });

    child.stdin.write(req.prompt);
    child.stdin.end();
  });
}
