import { useEffect, useRef, type ReactNode } from 'react';
import type { Account, Employee, Provider } from '../../../shared/types';
import { avatarURL, drawPortrait } from '../office/engine';
import { fmtCountdown } from '../api';

export function Modal({ title, onClose, children, wide, icon }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; icon?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal frame ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{icon && <span className="modal-icon">{icon}</span>}{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** HP/MP-style bar showing what is LEFT of a quota window. */
export function StatBar({ label, usedPercent, resetsAt, kind, compact }: { label: string; usedPercent?: number; resetsAt?: number; kind: 'hp' | 'mp'; compact?: boolean }) {
  const known = usedPercent !== undefined;
  const left = known ? Math.max(0, 100 - usedPercent!) : 0;
  const tone = !known ? 'unknown' : left <= 10 ? 'crit' : left <= 30 ? 'low' : 'ok';
  return (
    <div
      className={`stat ${kind} ${tone} ${compact ? 'compact' : ''}`}
      title={known ? `${label}: còn ${left}% · reset sau ${fmtCountdown(resetsAt) || '?'}` : 'Chưa có dữ liệu'}
    >
      <span className="stat-label">{label}</span>
      <div className="stat-track">
        <div className="stat-fill" style={{ width: `${left}%` }} />
      </div>
      <span className="stat-num">{known ? left : '–'}</span>
    </div>
  );
}

export function ProviderIcon({ provider, size = 18 }: { provider: Provider; size?: number }) {
  return (
    <span className={`prov-icon ${provider}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }} title={provider === 'claude' ? 'Claude' : 'Codex'}>
      {provider === 'claude' ? '✳' : '◎'}
    </span>
  );
}

export function Avatar({ e, size = 32, ring }: { e: Employee; size?: number; ring?: string }) {
  return (
    <span className={`avatar ${e.status}`} style={{ width: size, height: size, ['--ring' as any]: ring ?? 'transparent' }}>
      <img src={avatarURL(e)} alt="" width={size} height={size} />
    </span>
  );
}

export function Portrait({ e, size = 80 }: { e: Employee; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawPortrait(ref.current, e);
  }, [e]);
  return <canvas ref={ref} width={size} height={size * 1.4} className="portrait" />;
}

/** Pixel potion = a free full quota reset granted by the provider. */
export function Potions({ acc }: { acc: Account }) {
  const n = acc.resetCredits?.count ?? 0;
  if (!n) return null;
  const exp = acc.resetCredits?.expiresAt ? new Date(acc.resetCredits.expiresAt).toLocaleDateString('vi-VN') : '';
  return (
    <span className="potions" title={`${n} lượt reset miễn phí${acc.resetCredits?.title ? ` — ${acc.resetCredits.title}` : ''}${exp ? ` · hết hạn ${exp}` : ''}. Dùng trong ứng dụng Codex.`}>
      {Array.from({ length: Math.min(n, 3) }).map((_, i) => (
        <i key={i} className="potion" />
      ))}
      {n > 3 && <b>×{n}</b>}
    </span>
  );
}

export function Pill({ children, tone = 'default', title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, label, hint, danger }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; danger?: boolean }) {
  return (
    <label className={`toggle ${danger ? 'danger' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function AccountLine({ acc }: { acc?: Account }) {
  if (!acc) return <span className="muted">(không có tài khoản)</span>;
  return (
    <span className="acc-line">
      <i className="badge-dot" style={{ background: acc.color }} />
      <ProviderIcon provider={acc.provider} size={14} />
      {acc.label}
      {acc.email && <span className="muted"> · {acc.email}</span>}
    </span>
  );
}

export function accountsFor(accounts: Account[], provider?: Provider) {
  return accounts.filter((a) => !provider || a.provider === provider);
}

export function timeAgo(at?: number) {
  if (!at) return 'chưa rõ';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

export const MODEL_TIER_LABEL: Record<string, string> = { max: 'Đỉnh nhất', high: 'Mạnh', standard: 'Cân bằng', light: 'Nhanh · rẻ' };

/** Minimal, safe markdown: **bold**, `code`, "# heading" and "- " bullets. Rendered as React nodes (no innerHTML). */
export function Rich({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const heading = /^#{1,4}\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const body = heading ? heading[1] : bullet ? bullet[1] : line;
        const parts = body.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, k) =>
          p.startsWith('**') && p.endsWith('**') ? <b key={k}>{p.slice(2, -2)}</b> : p.startsWith('`') && p.endsWith('`') ? <code key={k}>{p.slice(1, -1)}</code> : p,
        );
        if (bullet) return <span key={i} className="rich-li">{parts}</span>;
        return (
          <span key={i}>
            {heading ? <b>{parts}</b> : parts}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}
