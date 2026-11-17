import { useState } from 'react';
import type { Account, AppSnapshot, Provider } from '../../../shared/types';
import { api, fmtCountdown, fmtTime } from '../api';
import { Modal, Potions, ProviderIcon, StatBar, timeAgo } from './ui';

export function AccountHud({ snap }: { snap: AppSnapshot }) {
  const [adding, setAdding] = useState(false);
  const staff = [snap.office.coordinator, ...snap.office.employees].filter(Boolean);
  return (
    <div className="hud">
      {snap.accounts.map((a) => (
        <AccountCard key={a.id} acc={a} users={staff.filter((e) => e!.accountId === a.id).map((e) => e!.name)} />
      ))}
      <button className="add-acc" onClick={() => setAdding(true)} title="Thêm tài khoản Claude / Codex khác">
        <span>＋</span>
        <small>Tài khoản</small>
      </button>
      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </div>
  );
}

function AccountCard({ acc, users }: { acc: Account; users: string[] }) {
  const [probing, setProbing] = useState(false);
  const cooling = acc.coolingUntil && acc.coolingUntil > Date.now();
  const stale = !acc.usage || Date.now() - acc.usage.updatedAt > 15 * 60_000;
  const probe = async () => {
    setProbing(true);
    try {
      await api('accounts/probe', { id: acc.id });
    } finally {
      setProbing(false);
    }
  };
  return (
    <div className={`acc-card ${acc.loggedIn ? '' : 'off'} ${cooling ? 'cooling' : ''} ${stale && acc.loggedIn ? 'stale' : ''}`} style={{ ['--badge' as any]: acc.color }}>
      <div className="acc-head">
        <ProviderIcon provider={acc.provider} size={22} />
        <div className="acc-name">
          <b>
            {acc.label}
            {acc.plan && <span className="plan">{acc.plan.toUpperCase()}</span>}
          </b>
          <small>{acc.loggedIn ? acc.displayName ?? acc.email : 'Chưa đăng nhập'}</small>
        </div>
        <Potions acc={acc} />
      </div>
      {acc.loggedIn ? (
        <>
          <StatBar label="5H" kind="hp" usedPercent={acc.usage?.fiveHour?.usedPercent} resetsAt={acc.usage?.fiveHour?.resetsAt} compact />
          <StatBar label="7D" kind="mp" usedPercent={acc.usage?.weekly?.usedPercent} resetsAt={acc.usage?.weekly?.resetsAt} compact />
          <div className="acc-foot">
            {cooling ? (
              <span className="warn">😴 nghỉ đến {fmtTime(acc.coolingUntil!)}</span>
            ) : (
              <span className={stale ? 'warn' : 'muted'} title={`5h reset sau ${fmtCountdown(acc.usage?.fiveHour?.resetsAt) || '?'} · 7 ngày reset sau ${fmtCountdown(acc.usage?.weekly?.resetsAt) || '?'}`}>
                {stale ? '⚠ ' : ''}
                {timeAgo(acc.usage?.updatedAt)}{stale ? ' · bấm ↻' : ''}
              </span>
            )}
            <span className="row tight">
              {users.length > 0 && <span className="users" title={`Đang dùng: ${users.join(', ')}`}>👥{users.length}</span>}
              <button
                className="mini-btn"
                onClick={probe}
                disabled={probing}
                title={acc.provider === 'claude' ? 'Đo hạn mức (chạy 1 lượt Haiku rất nhỏ)' : 'Làm mới hạn mức (miễn phí)'}
              >
                {probing ? '…' : '↻'}
              </button>
            </span>
          </div>
        </>
      ) : (
        <button className="px-btn tiny primary" onClick={() => api('accounts/login', { id: acc.id })}>Đăng nhập</button>
      )}
    </div>
  );
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>('claude');
  const [label, setLabel] = useState('');
  const [step, setStep] = useState<'form' | 'wait'>('form');
  const [err, setErr] = useState('');
  return (
    <Modal title="Thêm tài khoản" icon="🔑" onClose={onClose}>
      {step === 'form' ? (
        <>
          <p className="muted">
            Mỗi tài khoản có thư mục cấu hình riêng, nên chạy song song được 2 tài khoản Claude hoặc 2 tài khoản Codex. Một cửa sổ terminal sẽ mở ra để bạn đăng nhập.
          </p>
          <div className="choice-row">
            {(['claude', 'codex'] as Provider[]).map((p) => (
              <button key={p} className={`choice ${provider === p ? 'on' : ''}`} onClick={() => setProvider(p)}>
                <ProviderIcon provider={p} size={28} />
                <b>{p === 'claude' ? 'Claude' : 'Codex'}</b>
              </button>
            ))}
          </div>
          <label className="field">
            Tên gợi nhớ
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === 'claude' ? 'vd: Claude công ty' : 'vd: Codex phụ'} />
          </label>
          {err && <p className="error">{err}</p>}
          <div className="actions">
            <button className="px-btn" onClick={onClose}>Hủy</button>
            <button
              className="px-btn primary"
              onClick={async () => {
                try {
                  await api('accounts/add', { provider, label });
                  setStep('wait');
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
            >
              Mở cửa sổ đăng nhập →
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="wait-login">
            <div className="loader" />
            <p>Hoàn tất đăng nhập trong cửa sổ terminal vừa mở, rồi bấm nút bên dưới.</p>
          </div>
          <div className="actions">
            <button
              className="px-btn primary"
              onClick={async () => {
                await api('accounts/refresh', {});
                onClose();
              }}
            >
              ✓ Tôi đã đăng nhập xong
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
