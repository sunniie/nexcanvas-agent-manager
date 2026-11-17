import type { Account, Capability, Lang, Usage } from '../../shared/types.ts';

export interface TurnRequest {
  account: Account;
  /** Language of the activity texts shown in the UI. */
  lang: Lang;
  cwd: string;
  /** Extra folders the agent may read/write besides cwd (e.g. the shared .office folder). */
  extraDirs?: string[];
  model: string;
  effort?: string;
  /** Resume this session; omitted = start a new one. */
  sessionId?: string;
  prompt: string;
  /** Absolute paths of images to attach to this prompt (the model sees them directly). */
  images?: string[];
  /** Role card / standing instructions. Claude: appended system prompt. Codex: prefixed on the first turn. */
  systemAppend?: string;
  /** JSON schema for a structured final answer. */
  schema?: object;
  granted: Capability[];
  lean: boolean;
  /** Coordinator thinking turns: may read the repo, must not edit it. */
  readOnly?: boolean;
  onActivity?: (text: string) => void;
  onUsage?: (u: Partial<Usage>) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  structured?: any;
  sessionId?: string;
  usage: { input: number; output: number; cached: number; contextTokens: number };
  costUsd: number;
  /** Set when the turn failed because the account hit its usage limit. */
  limited?: { resetsAt?: number };
  error?: string;
}

export const LIMIT_PATTERN =
  /usage limit|rate limit|hit your limit|limit reached|quota|too many requests|429|resets? (at|in)/i;

/** Pull a JSON object out of free text (fallback when a CLI ignores the schema flag). */
export function extractJson(text: string): any {
  if (!text) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

/** Best-effort parse of "resets 3pm" / "try again at 3:05 PM" / epoch hints in a limit error. */
export function parseResetHint(text: string): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text)?.[1];
  if (epoch) return Number(epoch) * 1000;
  const m = /(?:at|resets?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function shortPath(p: string) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts.slice(-2).join('/');
}
