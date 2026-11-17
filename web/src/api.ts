import { useEffect, useState } from 'react';
import type { AppSnapshot, ServerEvent } from '../../shared/types';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

type BubbleFn = (id: string, text: string) => void;
const bubbleListeners = new Set<BubbleFn>();
export function onBubble(fn: BubbleFn) {
  bubbleListeners.add(fn);
  return () => void bubbleListeners.delete(fn);
}

export function useSnapshot() {
  const [snap, setSnap] = useState<AppSnapshot>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as ServerEvent;
        if (ev.type === 'snapshot') setSnap(ev.data);
        else if (ev.type === 'bubble') bubbleListeners.forEach((f) => f(ev.employeeId, ev.text));
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return { snap, connected };
}

export function fmtTokens(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCountdown(at?: number) {
  if (!at) return '';
  const ms = at - Date.now();
  if (ms <= 0) return 'đã reset';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}n ${h % 24}g`;
  return h ? `${h}g ${m}p` : `${m}p`;
}

export function fmtTime(at: number) {
  return new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}
