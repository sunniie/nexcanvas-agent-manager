import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountEnv, codexLastContext, codexRolloutFiles, codexUsageFromFile } from '../accounts.ts';
import { DEFAULT_CODEX_DIR, resolveBin } from '../paths.ts';
import { tr } from '../i18n.ts';
import type { Lang } from '../../shared/types.ts';
import { LIMIT_PATTERN, extractJson, parseResetHint, shortPath, type TurnRequest, type TurnResult } from './types.ts';

function sandboxFor(req: TurnRequest): string {
  if (req.readOnly) return 'read-only';
  if (req.granted.includes('full_access')) return 'danger-full-access';
  return 'workspace-write';
}

/**
 * Codex wraps every command in a shell invocation, e.g.
 * `"C:\...\pwsh.exe" -NoProfile -Command "npm test"` or `bash -lc 'npm test'`. Show only the real command.
 */
export function cleanCommand(cmd: string): string {
  let c = cmd.trim();
  c = c.replace(/^("[^"]*"|'[^']*'|\S+)\s+/, (m, exe: string) => (/(pwsh|powershell|bash|sh|zsh|cmd)(\.exe)?["']?$/i.test(exe) ? '' : m));
  c = c.replace(/^((-NoProfile|-NoLogo|-NonInteractive|-ExecutionPolicy\s+\S+|-Command|-c|-lc|\/c|\/d|\/s)\s+)+/i, '');
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) c = c.slice(1, -1);
  return c.trim();
}

function describeItem(lang: Lang, item: any): string | undefined {
  switch (item?.type) {
    case 'command_execution':
      return `⌨️ ${cleanCommand(String(item.command ?? '')).slice(0, 60)}`;
    case 'file_change':
      return `✏️ ${tr(lang, 'act.edit', { f: (item.changes ?? []).map((c: any) => shortPath(c.path)).slice(0, 2).join(', ') })}`;
    case 'web_search':
      return `🌐 ${tr(lang, 'act.web')}`;
    case 'mcp_tool_call':
      return `🔧 ${item.tool ?? 'tool'}`;
    case 'todo_list':
      return `📝 ${tr(lang, 'act.todo')}`;
    default:
      return undefined;
  }
}

export function runCodex(req: TurnRequest): Promise<TurnResult> {
  const sandbox = sandboxFor(req);
  const needsNetwork = req.granted.some((c) => c === 'network' || c === 'git_push' || c === 'deploy' || c === 'install_deps' || c === 'publish');
  // `--image=<file>` (with "=") so the multi-value flag never swallows the trailing "-" (prompt from stdin).
  const images = (req.images ?? []).filter((f) => fs.existsSync(f)).map((f) => `--image=${f}`);
  const common = [...images, '--json', '--skip-git-repo-check', '-m', req.model, '-c', `sandbox_mode="${sandbox}"`];
  if (req.effort) common.push('-c', `model_reasoning_effort="${req.effort}"`);
  if (sandbox === 'workspace-write' && needsNetwork) common.push('-c', 'sandbox_workspace_write.network_access=true');
  if (sandbox === 'workspace-write' && req.extraDirs?.length) {
    common.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(req.extraDirs)}`);
  }

  let schemaFile: string | undefined;
  if (req.schema) {
    schemaFile = path.join(os.tmpdir(), `nexcanvas-schema-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(schemaFile, JSON.stringify(req.schema));
    common.push('--output-schema', schemaFile);
  }

  // Codex has no "append system prompt" flag: the role card rides along with the first turn only,
  // after that the resumed thread already remembers it.
  const prompt = !req.sessionId && req.systemAppend ? `${req.systemAppend}\n\n---\n\n${req.prompt}` : req.prompt;
  const args = req.sessionId ? ['exec', 'resume', req.sessionId, ...common, '-'] : ['exec', ...common, '-'];

  return new Promise((resolve) => {
    const child = spawn(resolveBin('codex'), args, {
      cwd: req.cwd,
      env: accountEnv(req.account),
      windowsHide: true,
      signal: req.signal,
    });
    const result: TurnResult = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, contextTokens: 0 }, costUsd: 0 };
    let buf = '';
    let stderr = '';
    let failed = '';

    const handle = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'thread.started') result.sessionId = ev.thread_id;
      else if (ev.type === 'item.started' || ev.type === 'item.completed') {
        if (ev.item?.type === 'agent_message' && ev.type === 'item.completed') result.text = ev.item.text ?? result.text;
        else if (ev.type === 'item.started' || ev.item?.type === 'file_change') {
          const d = describeItem(req.lang, ev.item);
          if (d) req.onActivity?.(d);
        }
      } else if (ev.type === 'turn.completed') {
        result.ok = true;
        // OpenAI convention: input_tokens INCLUDES the cached part, and it is summed over every model
        // call in the turn. Normalize to the same meaning as Claude: input = uncached tokens only.
        const u = ev.usage ?? {};
        result.usage.cached = u.cached_input_tokens ?? 0;
        result.usage.input = Math.max(0, (u.input_tokens ?? 0) - result.usage.cached);
        result.usage.output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        failed = ev.error?.message ?? ev.message ?? JSON.stringify(ev);
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
    child.on('error', (err) => (failed = err.message));
    child.on('close', () => {
      if (buf.trim()) handle(buf);
      if (schemaFile) fs.rm(schemaFile, () => {});
      if (failed) result.ok = false;
      if (!result.ok) result.error = failed || stderr.trim().slice(-500) || 'Codex exited without a result';
      if (req.schema && result.ok) result.structured = extractJson(result.text);

      // Rate limits are only written to the session file — read them back after every turn.
      const home = req.account.configDir || DEFAULT_CODEX_DIR;
      const file = result.sessionId
        ? codexRolloutFiles(home, 60).find((f) => f.includes(result.sessionId!))
        : undefined;
      const usage = file ? codexUsageFromFile(file) : undefined;
      if (usage) req.onUsage?.({ fiveHour: usage.fiveHour, weekly: usage.weekly });
      // Real context size = the LAST model call's prompt (not the per-turn sum).
      const ctx = file ? codexLastContext(file) : undefined;
      if (ctx) result.usage.contextTokens = ctx;

      const errText = `${result.error ?? ''} ${stderr}`;
      if (!result.ok && LIMIT_PATTERN.test(errText)) {
        const blocked = [usage?.fiveHour, usage?.weekly].filter((w) => w && w.usedPercent >= 100);
        const resetsAt = blocked.length
          ? Math.max(...blocked.map((w) => w!.resetsAt ?? 0))
          : parseResetHint(errText) ?? usage?.fiveHour?.resetsAt;
        result.limited = { resetsAt: resetsAt || undefined };
      }
      resolve(result);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
