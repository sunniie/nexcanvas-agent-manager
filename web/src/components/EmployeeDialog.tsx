import { useEffect, useState } from 'react';
import type { AppSnapshot, Employee } from '../../../shared/types';
import { api, fmtTime, fmtTokens } from '../api';
import { t } from '../i18n';
import { SkillPicker } from './Setup';
import { STATUS_LABEL } from './Workspace';
import { AccountLine, Modal, Pill, Portrait, StatBar, tierLabel } from './ui';

export const EMP_STATUS: Record<Employee['status'], string> = {
  'walking-in': 'Walking in',
  idle: 'Idle',
  working: 'Working',
  sleeping: 'Napping until the quota resets',
  blocked: 'Blocked',
  meeting: 'In a meeting',
};
const EMP_ICON: Record<Employee['status'], string> = { 'walking-in': '🚶', idle: '☕', working: '⌨️', sleeping: '😴', blocked: '⛔', meeting: '🗣️' };

export function EmployeeDialog({ snap, id, onClose }: { snap: AppSnapshot; id: string; onClose: () => void }) {
  const o = snap.office!;
  const e = o.coordinator?.id === id ? o.coordinator : o.employees.find((x) => x.id === id);
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
  const tasks = o.tasks.filter((x) => x.assigneeId === e.id);
  const ctxPct = Math.min(100, Math.round((e.stats.contextTokens / o.settings.rotateAtTokens) * 100));
  const waiting = o.jobs.find((j) => j.employeeId === e.id && j.status === 'waiting_quota');

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
          <div className="emp-status">
            {EMP_ICON[e.status]} {t(EMP_STATUS[e.status])}
          </div>
          {activity && <div className="muted small">{activity}</div>}
          {e.statusText && !activity && <div className="warn small">{e.statusText}</div>}
          <div className="emp-stats">
            <div>
              <b>{e.stats.turns}</b>
              <small>{t('turns')}</small>
            </div>
            <div>
              <b>{fmtTokens(e.stats.inputTokens + e.stats.cachedTokens)}</b>
              <small>{t('in')}</small>
            </div>
            <div>
              <b>{fmtTokens(e.stats.outputTokens)}</b>
              <small>{t('out')}</small>
            </div>
          </div>
          <StatBar label="CTX" kind="mp" usedPercent={ctxPct} />
          <small className="muted">
            {t('Session context: {n} / {max}', { n: fmtTokens(e.stats.contextTokens), max: fmtTokens(o.settings.rotateAtTokens) })}
          </small>
        </div>

        <div className="emp-main">
          <div className="form-grid">
            <label className="field">
              {t('Name')}
              <input value={cur.name} onChange={(x) => setDraft({ ...draft, name: x.target.value })} disabled={e.isCoordinator} />
            </label>
            <label className="field">
              {t('Job title')}
              <input value={cur.title} onChange={(x) => setDraft({ ...draft, title: x.target.value })} disabled={e.isCoordinator} />
            </label>
          </div>
          <div className="form-grid three">
            <label className="field">
              {t('Signed-in account')}
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
              {t('Model')}
              <select value={cur.model} onChange={(x) => setDraft({ ...draft, model: x.target.value })}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label.replace(/\s*\(.*\)$/, '')} — {tierLabel(m.tier)}
                  </option>
                ))}
                {!models.some((m) => m.id === cur.model) && <option value={cur.model}>{cur.model}</option>}
              </select>
            </label>
            <label className="field">
              {t('Reasoning effort')}
              <select value={cur.effort} onChange={(x) => setDraft({ ...draft, effort: x.target.value })}>
                {efforts.map((v) => (
                  <option key={v}>{v}</option>
                ))}
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
          {draft.accountId && draft.accountId !== e.accountId && (
            <p className="warn small">{t('Switching accounts starts a new session; the employee re-reads its handover notebook, so no work is lost.')}</p>
          )}

          {!e.isCoordinator && (
            <>
              <h4>{t('Skills')}</h4>
              <SkillPicker all={snap.skills} provider={cur.provider} value={cur.skills} onChange={(skills) => setDraft({ ...draft, skills })} />
            </>
          )}

          <h4>{t('Session')}</h4>
          <div className="row" style={{ marginBottom: 4 }}>
            {e.branch && (
              <Pill tone="green" title={e.workdir}>
                ⎇ {e.branch}
              </Pill>
            )}
            {!e.branch && !e.isCoordinator && <Pill title={e.workdir}>📁 {t('Shared folder')}</Pill>}
            <Pill>{t('Shift #{n}', { n: e.sessionGeneration + 1 })}</Pill>
          </div>
          <p className="muted small">
            {e.sessionId ? (
              <>
                {t('Session')} <code>{e.sessionId.slice(0, 8)}…</code> — {t('resumed on every turn, so the employee remembers its work.')}
              </>
            ) : (
              t('No session yet (created on the first task).')
            )}
          </p>

          {tasks.length > 0 && (
            <>
              <h4>
                {t('Tasks')} ({tasks.length})
              </h4>
              <ul className="emp-tasks">
                {tasks
                  .slice(-6)
                  .reverse()
                  .map((x) => (
                    <li key={x.id}>
                      <code>{x.id}</code> {x.title} <span className={`status ${x.status}`}>{t(STATUS_LABEL[x.status])}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {err && <p className="error">{err}</p>}
          <div className="row end">
            {!e.isCoordinator && (
              <button
                className="px-btn small danger"
                onClick={() => {
                  if (confirm(t('Let {name} go?', { name: e.name }))) void api('employee/fire', { id: e.id }).then(onClose);
                }}
              >
                {t('Let go')}
              </button>
            )}
            <button className="px-btn small" disabled={!e.sessionId} onClick={() => api('employee/reset-session', { id: e.id })} title={t('Start a fresh session, keep the notebook')}>
              ↻ {t('New session')}
            </button>
            <button className="px-btn primary" disabled={!dirty} onClick={save}>
              {saved ? `✓ ${t('Saved')}` : t('Save')}
            </button>
          </div>
          {waiting?.resumeAt && (
            <p className="muted small">{t('Continues automatically at {time}. Want it now? Switch to an account with quota left and save.', { time: fmtTime(waiting.resumeAt) })}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
