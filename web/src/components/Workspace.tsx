import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITY_LABELS, MAX_CHAT_IMAGES, type AppSnapshot, type Capability, type Employee, type ImageUpload, type Task } from '../../../shared/types';
import { api, fmtTime, fmtTokens } from '../api';
import { t } from '../i18n';
import { attachmentURL, imageFiles, toUpload } from '../images';
import { Avatar, Pill, Rich, Toggle } from './ui';

type Tab = 'chat' | 'tasks' | 'settings';

export const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  waiting_quota: 'Waiting for quota',
  needs_permission: 'Needs permission',
  done: 'Done',
  failed: 'Failed',
};

export const CAP_LABEL: Record<Capability, string> = {
  git_commit: 'Git commit',
  git_push: 'Push to remote',
  install_deps: 'Install dependencies (npm/pip…)',
  deploy: 'Deploy',
  network: 'Network access',
  full_access: 'Full access (no sandbox)',
};
void CAPABILITY_LABELS;

export function Workspace({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const o = snap.office!;
  const open = o.tasks.filter((x) => x.status !== 'done' && x.status !== 'failed').length;
  return (
    <div className="workspace">
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          💬 {t('Chat')}
        </button>
        <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>
          📋 {t('Tasks')} {open > 0 && <em>{open}</em>}
        </button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          ⚙️ {t('Settings')}
        </button>
      </nav>
      {tab === 'chat' && <Chat snap={snap} onOpenEmployee={onOpenEmployee} />}
      {tab === 'tasks' && <TaskBoard snap={snap} onOpenEmployee={onOpenEmployee} />}
      {tab === 'settings' && <SettingsPanel snap={snap} />}
    </div>
  );
}

// ---------- chat ----------

const QUICK: Record<string, { icon: string; text: string }[]> = {
  code: [
    { icon: '📊', text: 'Report the current progress of the project' },
    { icon: '🧪', text: 'Run all tests and fix any failures' },
    { icon: '🔍', text: 'Review the latest changes for hidden bugs' },
  ],
  video: [
    { icon: '📝', text: 'Write a 30-second script for a product teaser' },
    { icon: '🎞️', text: 'Make a 9:16 version of the latest video with captions' },
    { icon: '📊', text: 'What tools for video work are available on this machine?' },
  ],
  other: [
    { icon: '🔎', text: 'Research this topic and write a short report with sources' },
    { icon: '📊', text: 'Analyze the data files in this folder and summarize the findings' },
    { icon: '❓', text: 'What can and can’t this office do for me?' },
  ],
};

function speakerName(who: string, staff: Map<string, Employee>) {
  if (who === 'boss') return t('You');
  if (who === 'system') return t('System');
  return staff.get(who)?.name ?? who;
}

function Chat({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const o = snap.office!;
  const log = o.log;
  const staff = useMemo(() => new Map(([o.coordinator, ...o.employees].filter(Boolean) as Employee[]).map((e) => [e.id, e])), [snap]);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  const leadBusy = snap.busy['lead'];

  return (
    <>
      <div
        className="chat"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {log.length === 0 && (
          <div className="empty">
            <span className="empty-icon">💬</span>
            <b>{t('The office is ready')}</b>
            <p>{t('Give the lead some work below. The lead splits it into tasks, the team does them, then the lead reports back.')}</p>
          </div>
        )}
        {log.map((l, i) => {
          const prev = log[i - 1];
          const grouped = prev && prev.who === l.who && prev.kind === l.kind && l.at - prev.at < 120_000 && !l.tag;
          if (l.kind === 'system' || l.kind === 'info') {
            return (
              <div key={i} className="sys-line">
                <span>{l.text}</span>
                <time>{fmtTime(l.at)}</time>
              </div>
            );
          }
          if (l.kind === 'user') {
            return (
              <div key={i} className="msg me">
                {!!l.images?.length && (
                  <div className="msg-images">
                    {l.images.map((n) => (
                      <a key={n} href={attachmentURL(o.id, n)} target="_blank" rel="noreferrer">
                        <img src={attachmentURL(o.id, n)} alt={t('Attached image')} loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                {l.text && (
                  <div className="bubble">
                    <Rich text={l.text} />
                  </div>
                )}
                {!grouped && <time>{fmtTime(l.at)}</time>}
              </div>
            );
          }
          const e = staff.get(l.who);
          const report = l.tag === 'report';
          return (
            <div key={i} className={`msg them ${l.kind} ${grouped ? 'grouped' : ''} ${report ? 'report' : ''}`}>
              <div className="msg-avatar">
                {!grouped && e && (
                  <button onClick={() => onOpenEmployee(e.id)} aria-label={e.name}>
                    <Avatar e={e} size={30} />
                  </button>
                )}
              </div>
              <div className="msg-col">
                {!grouped && (
                  <div className="msg-meta">
                    <b className={e?.isCoordinator ? 'lead' : ''}>{speakerName(l.who, staff)}</b>
                    {e && <span className="muted">{e.title}</span>}
                    {report && <span className="report-tag">📣 {t('Report')}</span>}
                    <time>{fmtTime(l.at)}</time>
                  </div>
                )}
                <div className="bubble">
                  <Rich text={l.text} />
                </div>
              </div>
            </div>
          );
        })}
        {leadBusy && (
          <div className="typing">
            <i />
            <i />
            <i />
            <span>
              {o.coordinator?.name}: {leadBusy}
            </span>
          </div>
        )}
      </div>
      <Composer snap={snap} />
    </>
  );
}

type Pending = ImageUpload & { preview: string; id: number };
let pendingSeq = 0;

function Composer({ snap }: { snap: AppSnapshot }) {
  const [msg, setMsg] = useState('');
  const [imgs, setImgs] = useState<Pending[]>([]);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const o = snap.office!;
  const leadBusy = !!snap.busy['lead'];

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setErr('');
    const room = MAX_CHAT_IMAGES - imgs.length;
    if (files.length > room) setErr(t('At most {n} images per message', { n: MAX_CHAT_IMAGES }));
    const added: Pending[] = [];
    for (const f of files.slice(0, Math.max(0, room))) {
      try {
        added.push({ ...(await toUpload(f)), id: ++pendingSeq });
      } catch {
        setErr(t('Could not read that image'));
      }
    }
    setImgs((cur) => [...cur, ...added].slice(0, MAX_CHAT_IMAGES));
  };

  const send = async (text = msg) => {
    if (!text.trim() && !imgs.length) return;
    setErr('');
    setSending(true);
    try {
      await api('chat', { message: text, images: imgs.map(({ name, data }) => ({ name, data })) });
      setMsg('');
      setImgs([]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(imageFiles(e.dataTransfer));
      }}
    >
      {!msg && !imgs.length && o.employees.length > 0 && (
        <div className="quick">
          {(QUICK[o.template] ?? QUICK.code).map((q) => (
            <button key={q.text} onClick={() => setMsg(t(q.text))}>
              {q.icon} {t(q.text)}
            </button>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {imgs.length > 0 && (
        <div className="attach-row">
          {imgs.map((im) => (
            <div key={im.id} className="attach-thumb">
              <img src={im.preview} alt={im.name} />
              <button onClick={() => setImgs((cur) => cur.filter((x) => x.id !== im.id))} aria-label={t('Remove image')} title={t('Remove image')}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        <button
          className="attach"
          onClick={() => fileInput.current?.click()}
          disabled={imgs.length >= MAX_CHAT_IMAGES}
          aria-label={t('Attach images')}
          title={t('Attach images')}
        >
          📎
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <textarea
          rows={2}
          value={msg}
          placeholder={t('Give work to the lead or ask a question…')}
          onChange={(e) => setMsg(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData);
            if (!files.length) return;
            // A pasted screenshot becomes an attachment; text in the same clipboard is still pasted.
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send" onClick={() => send()} disabled={(!msg.trim() && !imgs.length) || sending} aria-label={t('Send')}>
          ▶
        </button>
      </div>
      {dragging && <div className="drop-hint">{t('Drop images to attach')}</div>}
      <small className="composer-hint">
        {t('Enter to send · Shift+Enter for a new line · paste or drop screenshots')}
        {leadBusy ? ` · ${t('the lead is busy, your message will be queued')}` : ''}
      </small>
    </div>
  );
}

// ---------- tasks ----------

const GROUPS: { key: string; label: string; statuses: Task['status'][] }[] = [
  { key: 'attention', label: 'Needs your attention', statuses: ['needs_permission', 'failed'] },
  { key: 'active', label: 'Running', statuses: ['in_progress', 'review', 'waiting_quota'] },
  { key: 'todo', label: 'Queued', statuses: ['todo'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
];

function TaskBoard({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const o = snap.office!;
  const tasks = o.tasks;
  const staff = new Map(o.employees.map((e) => [e.id, e]));
  if (!tasks.length) {
    return (
      <div className="tab-scroll">
        <div className="empty">
          <span className="empty-icon">📋</span>
          <b>{t('No tasks yet')}</b>
          <p>{t('When you give the lead work, it is split into tasks that show up here.')}</p>
        </div>
      </div>
    );
  }
  const done = tasks.filter((x) => x.status === 'done').length;
  return (
    <div className="tab-scroll">
      <div className="progress-card">
        <div className="row">
          <b className="grow">{t('Progress')}</b>
          <span className="pixel-num">
            {done}/{tasks.length}
          </span>
        </div>
        <div className="progress">
          <div style={{ width: `${(done / tasks.length) * 100}%` }} />
        </div>
      </div>
      {GROUPS.map((g) => {
        const list = tasks.filter((x) => g.statuses.includes(x.status)).reverse();
        if (!list.length) return null;
        return (
          <section key={g.key} className={`task-group ${g.key}`}>
            <h4>
              {t(g.label)} <span>{list.length}</span>
            </h4>
            {list.map((x) => (
              <TaskCard key={x.id} task={x} e={staff.get(x.assigneeId)} snap={snap} onOpenEmployee={onOpenEmployee} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task, e, snap, onOpenEmployee }: { task: Task; e?: Employee; snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const [open, setOpen] = useState(task.status === 'needs_permission' || task.status === 'failed');
  const wait = snap.office!.jobs.find((j) => j.taskId === task.id && j.status === 'waiting_quota');
  const activity = e && snap.busy[e.id];
  return (
    <article className={`task ${task.status} ${open ? 'open' : ''}`}>
      <button className="task-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`dot ${task.status}`} />
        <span className="grow">
          <span className="tid">{task.id}</span>
          <b className="task-title">{task.title}</b>
          {task.status === 'in_progress' && activity && <small className="activity ellipsis">{activity}</small>}
        </span>
        {e && <Avatar e={e} size={24} />}
      </button>
      <div className="task-tags">
        <Pill tone={task.status}>{t(STATUS_LABEL[task.status])}</Pill>
        {task.merge?.status === 'merged' && <Pill tone="green" title={t('Merged into the main branch')}>🔀 {task.merge.commit}</Pill>}
        {task.merge?.status === 'conflict' && <Pill tone="red" title={task.merge.files?.join(', ')}>⚔️ {t('Conflict')}</Pill>}
        {task.merge?.status === 'failed' && <Pill tone="red" title={task.merge.note}>{t('Not merged')}</Pill>}
        {task.revisions > 0 && <Pill>{t('Revised ×{n}', { n: task.revisions })}</Pill>}
        {wait?.resumeAt && <Pill tone="blue">⏰ {fmtTime(wait.resumeAt)}</Pill>}
      </div>
      {open && (
        <div className="task-body">
          <p>{task.description}</p>
          <p>
            <span className="field-label">{t('Acceptance')}</span>
            {task.acceptance}
          </p>
          <p className="row">
            <span className="field-label">{t('Assignee')}</span>
            {e ? (
              <button className="link" onClick={() => onOpenEmployee(e.id)}>
                {e.name} · {e.title}
              </button>
            ) : (
              '—'
            )}
            {task.dependsOn.length > 0 && <span className="muted"> · {t('after {ids}', { ids: task.dependsOn.join(', ') })}</span>}
          </p>
          {task.report && (
            <div className="report">
              <Rich text={task.report.summary} />
              {task.report.files_changed.length > 0 && (
                <div className="files">
                  {task.report.files_changed.map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </div>
              )}
              {task.report.tests && <div className="muted">🧪 {task.report.tests}</div>}
              {task.report.blockers && <div className="warn">⛔ {task.report.blockers}</div>}
            </div>
          )}
          {task.reviewNote && (
            <p className="review-note">
              🔍 <Rich text={task.reviewNote} />
            </p>
          )}
          {task.status === 'failed' && (
            <button className="px-btn small" onClick={() => api('task/retry', { id: task.id })}>
              ↻ {t('Retry')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// ---------- settings ----------

function SettingsPanel({ snap }: { snap: AppSnapshot }) {
  const o = snap.office!;
  const caps = Object.keys(CAP_LABEL) as Capability[];
  const set = (patch: Record<string, unknown>) => api('settings', patch);
  const staff = [o.coordinator, ...o.employees].filter(Boolean) as Employee[];
  const totals = staff.reduce((a, e) => ({ in: a.in + e.stats.inputTokens, cached: a.cached + e.stats.cachedTokens, out: a.out + e.stats.outputTokens }), { in: 0, cached: 0, out: 0 });
  const hit = Math.round((100 * totals.cached) / Math.max(1, totals.cached + totals.in));
  const worktreeOn = o.gitRepo && (o.settings.isolation === 'worktree' || (o.settings.isolation === 'auto' && o.employees.length > 1));

  return (
    <div className="tab-scroll settings">
      <section className="set-card">
        <h4>🔐 {t('Granted permissions')}</h4>
        <p className="muted small">{t('Granted once, used for every later task in this project.')}</p>
        {caps.map((c) => (
          <Toggle
            key={c}
            checked={o.granted.includes(c)}
            danger={c === 'full_access'}
            onChange={(v) => (v ? api('permissions/grant', { caps: [c] }) : api('permissions/revoke', { cap: c }))}
            label={t(CAP_LABEL[c])}
            hint={c === 'full_access' ? t('Removes the sandbox — only for projects you trust') : undefined}
          />
        ))}
      </section>

      <section className="set-card">
        <h4>🌿 {t('Parallel work')}</h4>
        {!o.gitRepo && <p className="warn small">{t('This folder is not a git repository (or has no commit yet) — everyone works in the same folder.')}</p>}
        <div className="seg">
          {(
            [
              ['auto', 'Automatic', 'Own branch when ≥ 2 people'],
              ['worktree', 'Always branches', 'One git worktree per person'],
              ['shared', 'Shared folder', 'No branches'],
            ] as const
          ).map(([v, label, hint]) => (
            <button key={v} className={o.settings.isolation === v ? 'on' : ''} disabled={!o.gitRepo && v !== 'shared'} onClick={() => set({ isolation: v })}>
              <b>{t(label)}</b>
              <small>{t(hint)}</small>
            </button>
          ))}
        </div>
        <p className="muted small">
          {worktreeOn
            ? t('On: each employee works on its own office/* branch; approved work is merged into "{branch}" automatically.', { branch: o.mainBranch ?? 'main' })
            : t('Employees edit the project folder directly; you commit when you want.')}
        </p>
        <label className="field inline">
          {t('Max people working at once')}
          <select value={o.settings.maxParallel} onChange={(e) => set({ maxParallel: Number(e.target.value) })}>
            {[1, 2, 3, 4, 6].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="set-card">
        <h4>😴 {t('When quota runs out')}</h4>
        <div className="radio-list">
          {(
            [
              ['off', 'Wait for the reset, then continue', 'Naps on the sofa and resumes the same session'],
              ['same', 'Switch to another account of the same kind', 'Claude → another Claude, Codex → another Codex'],
              ['any', 'Switch to any account with quota left', 'May switch Claude ↔ Codex (keeps the model tier)'],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className={`radio ${o.settings.failover === v ? 'on' : ''}`}>
              <input type="radio" name="failover" checked={o.settings.failover === v} onChange={() => set({ failover: v })} />
              <span>
                <b>{t(label)}</b>
                <small>{t(hint)}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="set-card">
        <h4>🪙 {t('Token saving')}</h4>
        <Toggle checked={o.settings.leanMode} onChange={(v) => set({ leanMode: v })} label={t('Lean sessions')} hint={t('No MCP servers in agent sessions (~20% less context)')} />
        <label className="field inline">
          {t('Hand over to a fresh session above')}
          <select value={o.settings.rotateAtTokens} onChange={(e) => set({ rotateAtTokens: Number(e.target.value) })}>
            {[80_000, 120_000, 150_000, 250_000, 600_000].map((v) => (
              <option key={v} value={v}>
                {fmtTokens(v)}
              </option>
            ))}
          </select>
        </label>
        <div className="stats-grid">
          <div>
            <b>{fmtTokens(totals.in)}</b>
            <small>{t('new tokens')}</small>
          </div>
          <div>
            <b>{fmtTokens(totals.cached)}</b>
            <small>{t('from cache')}</small>
          </div>
          <div>
            <b>{fmtTokens(totals.out)}</b>
            <small>{t('output')}</small>
          </div>
          <div className={hit >= 80 ? 'good' : ''}>
            <b>{hit}%</b>
            <small>{t('cache hit')}</small>
          </div>
        </div>
      </section>

      <section className="set-card">
        <h4>🏢 {t('Office')}</h4>
        <p className="muted small ellipsis" title={o.projectDir}>
          📁 {o.projectDir}
          {o.mainBranch ? ` · ⎇ ${o.mainBranch}` : ''}
        </p>
        <div className="row">
          <button className="px-btn small" disabled={o.employees.length >= 6} onClick={() => api('office/add-staff', {})}>
            ＋ {t('Hire more')}
          </button>
          <button className="px-btn small" onClick={() => api('offices/close', {})}>
            ← {t('Back to the lobby')}
          </button>
        </div>
      </section>
    </div>
  );
}
