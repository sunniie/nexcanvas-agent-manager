import { useEffect, useState } from 'react';
import type { AppSnapshot, Employee } from '../../../shared/types';
import { api, fmtTime, fmtTokens } from '../api';
import { SkillPicker } from './Setup';
import { AccountLine, MODEL_TIER_LABEL, Modal, Pill, Portrait, StatBar } from './ui';

const STATUS: Record<Employee['status'], string> = {
  'walking-in': '🚶 Đang vào văn phòng',
  idle: '☕ Rảnh',
  working: '⌨️ Đang làm việc',
  sleeping: '😴 Nghỉ chờ hạn mức',
  blocked: '⛔ Bị chặn',
  meeting: '🗣️ Đang họp',
};

export function EmployeeDialog({ snap, id, onClose }: { snap: AppSnapshot; id: string; onClose: () => void }) {
  const e = snap.office.coordinator?.id === id ? snap.office.coordinator : snap.office.employees.find((x) => x.id === id);
  const [draft, setDraft] = useState<Partial<Employee>>({});
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft({});
  }, [id]);
  if (!e) return null;

  const cur = { ...e, ...draft };
  const acc = snap.accounts.find((a) => a.id === cur.accountId);
  const models = snap.models[cur.provider];
  const efforts = models.find((m) => m.id === cur.model)?.efforts ?? ['low', 'medium', 'high'];
  const activity = snap.busy[e.id];
  const dirty = Object.keys(draft).length > 0;
  const tasks = snap.office.tasks.filter((t) => t.assigneeId === e.id);
  const ctxPct = Math.min(100, Math.round((e.stats.contextTokens / snap.office.settings.rotateAtTokens) * 100));

  const save = async () => {
    setErr('');
    try {
      await api('employee/update', { id: e.id, patch: draft });
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (x: any) {
      setErr(x.message);
    }
  };

  return (
    <Modal title={`${e.name} · ${e.title}`} icon={e.isCoordinator ? '★' : '🪪'} onClose={onClose} wide>
      <div className="emp">
        <div className="emp-side">
          <Portrait e={e} size={96} />
          <div className="emp-status">{STATUS[e.status]}</div>
          {activity && <div className="muted small">{activity}</div>}
          {e.statusText && <div className="warn small">{e.statusText}</div>}
          <div className="emp-stats">
            <div><b>{e.stats.turns}</b><small>lượt</small></div>
            <div><b>{fmtTokens(e.stats.inputTokens + e.stats.cachedTokens)}</b><small>vào</small></div>
            <div><b>{fmtTokens(e.stats.outputTokens)}</b><small>ra</small></div>
          </div>
          <StatBar label="CTX" kind="mp" usedPercent={ctxPct} />
          <small className="muted">Ngữ cảnh phiên: {fmtTokens(e.stats.contextTokens)} / {fmtTokens(snap.office.settings.rotateAtTokens)}</small>
        </div>

        <div className="emp-main">
          <div className="form-grid">
            <label className="field">
              Tên
              <input value={cur.name} onChange={(x) => setDraft({ ...draft, name: x.target.value })} disabled={e.isCoordinator} />
            </label>
            <label className="field">
              Chức danh
              <input value={cur.title} onChange={(x) => setDraft({ ...draft, title: x.target.value })} disabled={e.isCoordinator} />
            </label>
          </div>
          <div className="form-grid three">
            <label className="field">
              Tài khoản đăng nhập
              <select
                value={cur.accountId}
                onChange={(x) => {
                  const a = snap.accounts.find((y) => y.id === x.target.value)!;
                  const model = a.provider === cur.provider ? cur.model : snap.models[a.provider].find((m) => m.tier === 'high')?.id ?? snap.models[a.provider][0].id;
                  setDraft({ ...draft, accountId: a.id, provider: a.provider, model });
                }}
              >
                {snap.accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.loggedIn}>
                    {a.provider === 'claude' ? '✳ Claude' : '◎ Codex'} · {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model
              <select value={cur.model} onChange={(x) => setDraft({ ...draft, model: x.target.value })}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label} — {MODEL_TIER_LABEL[m.tier]}</option>)}
                {!models.some((m) => m.id === cur.model) && <option value={cur.model}>{cur.model}</option>}
              </select>
            </label>
            <label className="field">
              Độ suy nghĩ
              <select value={cur.effort} onChange={(x) => setDraft({ ...draft, effort: x.target.value })}>
                {efforts.map((v) => <option key={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <AccountLine acc={acc} />
          {acc && (
            <div className="mini-stats">
              <StatBar label="5H" kind="hp" usedPercent={acc.usage?.fiveHour?.usedPercent} resetsAt={acc.usage?.fiveHour?.resetsAt} />
              <StatBar label="7D" kind="mp" usedPercent={acc.usage?.weekly?.usedPercent} resetsAt={acc.usage?.weekly?.resetsAt} />
            </div>
          )}
          {(draft.accountId && draft.accountId !== e.accountId) && (
            <p className="warn small">Đổi tài khoản sẽ mở phiên mới; nhân viên đọc lại sổ tay giao ca nên không mất việc đang làm.</p>
          )}

          {!e.isCoordinator && (
            <>
              <h4>Skill</h4>
              <SkillPicker all={snap.skills} provider={cur.provider} value={cur.skills} onChange={(skills) => setDraft({ ...draft, skills })} />
            </>
          )}

          <h4>Phiên làm việc</h4>
          <div className="row" style={{ marginBottom: 4 }}>
            {e.branch && <Pill tone="green" title={e.workdir}>⎇ {e.branch}</Pill>}
            {!e.branch && !e.isCoordinator && <Pill title={e.workdir}>📁 Thư mục chung</Pill>}
            <Pill>Ca #{e.sessionGeneration + 1}</Pill>
          </div>
          <p className="muted small">
            {e.sessionId ? <>Session <code>{e.sessionId.slice(0, 8)}…</code> · ca thứ {e.sessionGeneration + 1} — được resume mỗi lượt nên nhân viên nhớ việc đã làm.</> : 'Chưa có phiên (sẽ tạo ở task đầu tiên).'}
          </p>

          {tasks.length > 0 && (
            <>
              <h4>Task ({tasks.length})</h4>
              <ul className="emp-tasks">
                {tasks.slice(-6).reverse().map((t) => (
                  <li key={t.id}><code>{t.id}</code> {t.title} <span className={`status ${t.status}`}>{t.status}</span></li>
                ))}
              </ul>
            </>
          )}

          {err && <p className="error">{err}</p>}
          <div className="row end">
            {!e.isCoordinator && (
              <button className="px-btn small danger" onClick={() => confirm(`Cho ${e.name} nghỉ việc?`) && api('employee/fire', { id: e.id }).then(onClose)}>
                Cho nghỉ
              </button>
            )}
            <button className="px-btn small" disabled={!e.sessionId} onClick={() => api('employee/reset-session', { id: e.id })} title="Bắt đầu phiên mới, giữ sổ tay">
              ↻ Phiên mới
            </button>
            <button className="px-btn primary" disabled={!dirty} onClick={save}>{saved ? '✓ Đã lưu' : 'Lưu'}</button>
          </div>
          {snap.office.jobs.some((j) => j.employeeId === e.id && j.status === 'waiting_quota') && (
            <p className="muted small">
              Tự làm tiếp lúc {fmtTime(snap.office.jobs.find((j) => j.employeeId === e.id && j.status === 'waiting_quota')!.resumeAt!)}. Muốn chạy ngay? Đổi sang tài khoản còn hạn mức rồi Lưu.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
