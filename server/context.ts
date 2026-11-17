import fs from 'node:fs';
import path from 'node:path';
import type { PastSession } from '../shared/types.ts';
import { getAccounts } from './accounts.ts';
import { DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR } from './paths.ts';

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Claude Code stores sessions per project in a folder named after the path with non-alphanumerics → '-'. */
function claudeProjectFolder(projectDir: string) {
  return path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

function readHead(file: string, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
    .map((b) => b.text)
    .join('\n');
}

const NOISE = /^(<(system-reminder|command-|local-command|environment_context|user_instructions|ide_)|# AGENTS\.md|Caveat:)/;

function cleanUserText(t: string) {
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '').trim();
}

export function findPastSessions(projectDir: string): PastSession[] {
  const out: PastSession[] = [];
  const target = norm(projectDir);

  // Claude: every Claude profile (default + extra accounts) may have sessions for this folder.
  const claudeDirs = new Set([DEFAULT_CLAUDE_DIR, ...getAccounts().filter((a) => a.provider === 'claude' && a.configDir).map((a) => a.configDir)]);
  for (const dir of claudeDirs) {
    const projects = path.join(dir, 'projects');
    let folders: string[] = [];
    try {
      folders = fs.readdirSync(projects);
    } catch {
      continue;
    }
    const wanted = claudeProjectFolder(projectDir);
    for (const f of folders.filter((x) => x.toLowerCase() === wanted)) {
      for (const file of fs.readdirSync(path.join(projects, f)).filter((x) => x.endsWith('.jsonl'))) {
        const full = path.join(projects, f, file);
        const stat = fs.statSync(full);
        const head = readHead(full);
        let title = '';
        let started = stat.birthtimeMs;
        let messages = 0;
        for (const line of head.split('\n')) {
          try {
            const j = JSON.parse(line);
            if (j.type === 'user' || j.type === 'assistant') messages++;
            if (!title && j.type === 'user') {
              const t = cleanUserText(textOf(j.message?.content));
              if (t && !NOISE.test(t)) {
                title = t.slice(0, 90);
                if (j.timestamp) started = Date.parse(j.timestamp);
              }
            }
          } catch {
            /* partial line */
          }
        }
        if (!title) continue;
        out.push({ provider: 'claude', id: file.replace('.jsonl', ''), file: full, startedAt: started, updatedAt: stat.mtimeMs, title, messages: Math.max(messages, Math.round(stat.size / 4000)) });
      }
    }
  }

  // Codex: rollout files carry the cwd in their first `session_meta` line.
  const codexHomes = new Set([DEFAULT_CODEX_DIR, ...getAccounts().filter((a) => a.provider === 'codex' && a.configDir).map((a) => a.configDir)]);
  for (const home of codexHomes) {
    for (const sub of ['sessions', 'archived_sessions']) {
      const files: string[] = [];
      const walk = (d: string, depth: number) => {
        let es: fs.Dirent[] = [];
        try {
          es = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of es) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && depth < 3) walk(p, depth + 1);
          else if (e.name.endsWith('.jsonl')) files.push(p);
        }
      };
      walk(path.join(home, sub), 0);
      for (const full of files) {
        const head = readHead(full, 32 * 1024);
        const firstLine = head.split('\n')[0];
        let meta: any;
        try {
          meta = JSON.parse(firstLine);
        } catch {
          continue;
        }
        const cwd = meta?.payload?.cwd;
        if (!cwd || norm(cwd) !== target) continue;
        let title = '';
        for (const line of head.split('\n').slice(1)) {
          try {
            const j = JSON.parse(line);
            const p = j.payload;
            if (j.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
              const t = textOf(p.content).trim();
              if (t && !NOISE.test(t)) {
                title = t.slice(0, 90);
                break;
              }
            }
          } catch {
            /* partial */
          }
        }
        const stat = fs.statSync(full);
        out.push({
          provider: 'codex',
          id: meta.payload.id ?? path.basename(full),
          file: full,
          startedAt: Date.parse(meta.payload.timestamp ?? meta.timestamp) || stat.birthtimeMs,
          updatedAt: stat.mtimeMs,
          title: title || '(phiên Codex)',
          messages: Math.round(stat.size / 4000),
        });
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Turn a raw session log into a compact transcript WITHOUT calling a model:
 * keep the user's messages and the agent's final reply of each turn, drop tool calls/results.
 * Typically shrinks a session by 90%+ before the coordinator ever reads it.
 */
export function digestSession(s: PastSession, maxChars = 24000): string {
  let raw = '';
  try {
    raw = fs.readFileSync(s.file, 'utf8');
  } catch {
    return '';
  }
  const turns: { role: 'user' | 'agent'; text: string }[] = [];
  for (const line of raw.split('\n')) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    let role: 'user' | 'agent' | undefined;
    let text = '';
    if (s.provider === 'claude') {
      if (j.type === 'user' && !j.isMeta) {
        role = 'user';
        text = cleanUserText(textOf(j.message?.content));
      } else if (j.type === 'assistant') {
        role = 'agent';
        text = textOf(j.message?.content);
      }
    } else if (j.type === 'response_item' && j.payload?.type === 'message') {
      role = j.payload.role === 'user' ? 'user' : j.payload.role === 'assistant' ? 'agent' : undefined;
      text = textOf(j.payload.content);
    }
    text = text.trim();
    if (!role || !text || NOISE.test(text)) continue;
    const last = turns[turns.length - 1];
    // Consecutive agent messages: keep only the latest (the turn's conclusion).
    if (last && last.role === 'agent' && role === 'agent') last.text = text;
    else turns.push({ role, text });
  }
  const lines = turns.map((t) => (t.role === 'user' ? `USER: ${t.text.slice(0, 1500)}` : `AGENT: ${t.text.slice(0, 900)}`));
  let body = lines.join('\n\n');
  if (body.length > maxChars) {
    // Recent history matters most: keep 25% from the start, 75% from the end.
    const headLen = Math.floor(maxChars * 0.25);
    body = `${body.slice(0, headLen)}\n\n[... lược bớt phần giữa ...]\n\n${body.slice(-(maxChars - headLen))}`;
  }
  const date = new Date(s.startedAt).toISOString().slice(0, 10);
  return `# Phiên ${s.provider} ${s.id} (${date})\nChủ đề: ${s.title}\n\n${body}\n`;
}

/** Prompt the user pastes into an old chat to export a handoff document manually. */
export const EXPORT_PROMPT = `Hãy viết một TÀI LIỆU BÀN GIAO (plain text) cho toàn bộ cuộc trò chuyện này, để một AI khác tiếp quản dự án mà không cần đọc lại lịch sử. Gồm đúng các mục:
1. Mục tiêu dự án & yêu cầu của người dùng (giữ nguyên các yêu cầu quan trọng).
2. Các quyết định kỹ thuật đã chốt và LÝ DO.
3. Trạng thái hiện tại: đã xong gì, đang dở gì.
4. Các file/thư mục quan trọng và vai trò của chúng.
5. Việc cần làm tiếp theo (theo thứ tự ưu tiên).
6. Những lỗi/cạm bẫy đã gặp và cách đã xử lý.
7. Sở thích/quy ước của người dùng (code style, ngôn ngữ, công cụ).
Viết ngắn gọn, gạch đầu dòng, không chào hỏi. Tối đa ~1500 từ.`;
