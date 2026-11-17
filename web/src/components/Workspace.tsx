import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITY_LABELS, type AppSnapshot, type Capability, type Employee, type Task } from '../../../shared/types';
import { api, fmtTime, fmtTokens } from '../api';
import { Avatar, Pill, Rich, Toggle } from './ui';

type Tab = 'chat' | 'tasks' | 'settings';

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'Chờ làm',
  in_progress: 'Đang làm',
  review: 'Đang review',
  waiting_quota: 'Chờ hạn mức',
  needs_permission: 'Cần quyền',
  done: 'Xong',
  failed: 'Lỗi',
};

export function Workspace({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const o = snap.office;
  const open = o.tasks.filter((t) => t.status !== 'done' && t.status !== 'failed').length;
  return (
    <div className="workspace">
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          💬 Hội thoại
        </button>
        <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>
          📋 Công việc {open > 0 && <em>{open}</em>}
        </button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          ⚙️ Thiết lập
        </button>
      </nav>
      {tab === 'chat' && <Chat snap={snap} onOpenEmployee={onOpenEmployee} />}
      {tab === 'tasks' && <TaskBoard snap={snap} onOpenEmployee={onOpenEmployee} />}
      {tab === 'settings' && <SettingsPanel snap={snap} />}
    </div>
  );
}

// ---------- chat ----------

const QUICK = [
  { icon: '📊', text: 'Báo cáo tiến độ hiện tại của dự án' },
  { icon: '🧪', text: 'Chạy toàn bộ test và sửa nếu có lỗi' },
  { icon: '🔍', text: 'Review lại code vừa làm, tìm lỗi tiềm ẩn' },
];

function Chat({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const log = snap.office.log;
  const staff = useMemo(() => new Map([snap.office.coordinator, ...snap.office.employees].filter(Boolean).map((e) => [e!.name, e!])), [snap]);
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
            <b>Văn phòng đã sẵn sàng</b>
            <p>Giao việc cho Trưởng phòng ở ô bên dưới. Trưởng phòng sẽ chia task, nhân viên làm, rồi báo cáo lại cho bạn.</p>
          </div>
        )}
        {log.map((l, i) => {
          const prev = log[i - 1];
          const grouped = prev && prev.who === l.who && prev.kind === l.kind && l.at - prev.at < 120_000;
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
                <div className="bubble">
                  <Rich text={l.text} />
                </div>
                {!grouped && <time>{fmtTime(l.at)}</time>}
              </div>
            );
          }
          const e = staff.get(l.who);
          const report = l.text.startsWith('📣');
          return (
            <div key={i} className={`msg them ${l.kind} ${grouped ? 'grouped' : ''} ${report ? 'report' : ''}`}>
              <div className="msg-avatar">{!grouped && e && <button onClick={() => onOpenEmployee(e.id)} aria-label={e.name}><Avatar e={e} size={30} /></button>}</div>
              <div className="msg-col">
                {!grouped && (
                  <div className="msg-meta">
                    <b className={e?.isCoordinator ? 'lead' : ''}>{l.who}</b>
                    {e && <span className="muted">{e.title}</span>}
                    <time>{fmtTime(l.at)}</time>
                  </div>
                )}
                <div className="bubble">
                  <Rich text={report ? l.text.replace(/^📣\s*Báo cáo:\s*/, '') : l.text} />
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
            <span>Trưởng phòng: {leadBusy}</span>
          </div>
        )}
      </div>
      <Composer snap={snap} />
    </>
  );
}

function Composer({ snap }: { snap: AppSnapshot }) {
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const leadBusy = !!snap.busy['lead'];
  const send = async (text = msg) => {
    if (!text.trim()) return;
    setErr('');
    setSending(true);
    try {
      await api('chat', { message: text });
      setMsg('');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      {!msg && snap.office.employees.length > 0 && (
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q.text} onClick={() => setMsg(q.text)}>
              {q.icon} {q.text}
            </button>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="composer-box">
        <textarea
          rows={2}
          value={msg}
          placeholder="Giao việc hoặc hỏi Trưởng phòng…"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="send" onClick={() => send()} disabled={!msg.trim() || sending} aria-label="Gửi">
          ▶
        </button>
      </div>
      <small className="composer-hint">Enter để gửi · Shift+Enter xuống dòng{leadBusy ? ' · Trưởng phòng đang bận, tin nhắn sẽ được xếp hàng' : ''}</small>
    </div>
  );
}

// ---------- tasks ----------

const GROUPS: { key: string; label: string; statuses: Task['status'][] }[] = [
  { key: 'attention', label: 'Cần bạn chú ý', statuses: ['needs_permission', 'failed'] },
  { key: 'active', label: 'Đang chạy', statuses: ['in_progress', 'review', 'waiting_quota'] },
  { key: 'todo', label: 'Đang chờ', statuses: ['todo'] },
  { key: 'done', label: 'Đã xong', statuses: ['done'] },
];

function TaskBoard({ snap, onOpenEmployee }: { snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const tasks = snap.office.tasks;
  const staff = new Map(snap.office.employees.map((e) => [e.id, e]));
  if (!tasks.length) {
    return (
      <div className="tab-scroll">
        <div className="empty">
          <span className="empty-icon">📋</span>
          <b>Chưa có công việc</b>
          <p>Khi bạn giao việc, Trưởng phòng sẽ chia thành các task và chúng xuất hiện ở đây.</p>
        </div>
      </div>
    );
  }
  const done = tasks.filter((t) => t.status === 'done').length;
  return (
    <div className="tab-scroll">
      <div className="progress-card">
        <div className="row">
          <b className="grow">Tiến độ</b>
          <span className="pixel-num">{done}/{tasks.length}</span>
        </div>
        <div className="progress">
          <div style={{ width: `${(done / tasks.length) * 100}%` }} />
        </div>
      </div>
      {GROUPS.map((g) => {
        const list = tasks.filter((t) => g.statuses.includes(t.status)).reverse();
        if (!list.length) return null;
        return (
          <section key={g.key} className={`task-group ${g.key}`}>
            <h4>
              {g.label} <span>{list.length}</span>
            </h4>
            {list.map((t) => (
              <TaskCard key={t.id} t={t} e={staff.get(t.assigneeId)} snap={snap} onOpenEmployee={onOpenEmployee} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ t, e, snap, onOpenEmployee }: { t: Task; e?: Employee; snap: AppSnapshot; onOpenEmployee: (id: string) => void }) {
  const [open, setOpen] = useState(t.status === 'needs_permission' || t.status === 'failed');
  const wait = snap.office.jobs.find((j) => j.taskId === t.id && j.status === 'waiting_quota');
  const activity = e && snap.busy[e.id];
  return (
    <article className={`task ${t.status} ${open ? 'open' : ''}`}>
      <button className="task-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`dot ${t.status}`} />
        <span className="grow">
          <span className="tid">{t.id}</span>
          <b className="task-title">{t.title}</b>
          {t.status === 'in_progress' && activity && <small className="activity ellipsis">{activity}</small>}
        </span>
        {e && <Avatar e={e} size={24} />}
      </button>
      <div className="task-tags">
        <Pill tone={t.status}>{STATUS_LABEL[t.status]}</Pill>
        {t.merge?.status === 'merged' && <Pill tone="green" title="Đã gộp vào nhánh chính">🔀 {t.merge.commit}</Pill>}
        {t.merge?.status === 'conflict' && <Pill tone="red" title={t.merge.files?.join(', ')}>⚔️ Xung đột</Pill>}
        {t.merge?.status === 'failed' && <Pill tone="red" title={t.merge.note}>Chưa gộp được</Pill>}
        {t.revisions > 0 && <Pill>Sửa lại ×{t.revisions}</Pill>}
        {wait?.resumeAt && <Pill tone="blue">⏰ {fmtTime(wait.resumeAt)}</Pill>}
      </div>
      {open && (
        <div className="task-body">
          <p>{t.description}</p>
          <p><span className="field-label">Nghiệm thu</span>{t.acceptance}</p>
          <p className="row">
            <span className="field-label">Người làm</span>
            {e ? <button className="link" onClick={() => onOpenEmployee(e.id)}>{e.name} · {e.title}</button> : '—'}
            {t.dependsOn.length > 0 && <span className="muted"> · sau {t.dependsOn.join(', ')}</span>}
          </p>
          {t.report && (
            <div className="report">
              <Rich text={t.report.summary} />
              {t.report.files_changed.length > 0 && <div className="files">{t.report.files_changed.map((f) => <code key={f}>{f}</code>)}</div>}
              {t.report.tests && <div className="muted">🧪 {t.report.tests}</div>}
              {t.report.blockers && <div className="warn">⛔ {t.report.blockers}</div>}
            </div>
          )}
          {t.reviewNote && <p className="review-note">🔍 <Rich text={t.reviewNote} /></p>}
          {t.status === 'failed' && <button className="px-btn small" onClick={() => api('task/retry', { id: t.id })}>↻ Làm lại</button>}
        </div>
      )}
    </article>
  );
}

// ---------- settings ----------

function SettingsPanel({ snap }: { snap: AppSnapshot }) {
  const o = snap.office;
  const caps = Object.keys(CAPABILITY_LABELS) as Capability[];
  const set = (patch: Record<string, unknown>) => api('settings', patch);
  const staff = [o.coordinator, ...o.employees].filter(Boolean) as Employee[];
  const totals = staff.reduce(
    (a, e) => ({ in: a.in + e.stats.inputTokens, cached: a.cached + e.stats.cachedTokens, out: a.out + e.stats.outputTokens }),
    { in: 0, cached: 0, out: 0 },
  );
  const hit = Math.round((100 * totals.cached) / Math.max(1, totals.cached + totals.in));
  const worktreeOn = o.gitRepo && (o.settings.isolation === 'worktree' || (o.settings.isolation === 'auto' && o.employees.length > 1));

  return (
    <div className="tab-scroll settings">
      <section className="set-card">
        <h4>🔐 Quyền đã cấp</h4>
        <p className="muted small">Cấp một lần, dùng cho mọi task sau của dự án này.</p>
        {caps.map((c) => (
          <Toggle
            key={c}
            checked={o.granted.includes(c)}
            danger={c === 'full_access'}
            onChange={(v) => (v ? api('permissions/grant', { caps: [c] }) : api('permissions/revoke', { cap: c }))}
            label={CAPABILITY_LABELS[c]}
            hint={c === 'full_access' ? 'Bỏ sandbox — chỉ bật khi tin tưởng dự án' : undefined}
          />
        ))}
      </section>

      <section className="set-card">
        <h4>🌿 Làm việc song song</h4>
        {!o.gitRepo && <p className="warn small">Thư mục không phải git repo (hoặc chưa có commit) — mọi người làm chung một thư mục.</p>}
        <div className="seg">
          {([
            ['auto', 'Tự động', 'Nhánh riêng khi ≥ 2 người'],
            ['worktree', 'Luôn nhánh riêng', 'Mỗi người 1 git worktree'],
            ['shared', 'Thư mục chung', 'Không tạo nhánh'],
          ] as const).map(([v, label, hint]) => (
            <button key={v} className={o.settings.isolation === v ? 'on' : ''} disabled={!o.gitRepo && v !== 'shared'} onClick={() => set({ isolation: v })}>
              <b>{label}</b>
              <small>{hint}</small>
            </button>
          ))}
        </div>
        <p className="muted small">
          {worktreeOn
            ? `Đang bật: mỗi nhân viên làm trên nhánh office/* riêng; code được duyệt sẽ tự gộp vào "${o.mainBranch}".`
            : 'Nhân viên sửa trực tiếp trong thư mục dự án; bạn tự commit khi muốn.'}
        </p>
        <label className="field inline">
          Tối đa chạy cùng lúc
          <select value={o.settings.maxParallel} onChange={(e) => set({ maxParallel: Number(e.target.value) })}>
            {[1, 2, 3, 4, 6].map((v) => <option key={v} value={v}>{v} người</option>)}
          </select>
        </label>
      </section>

      <section className="set-card">
        <h4>😴 Khi hết hạn mức</h4>
        <div className="radio-list">
          {([
            ['off', 'Chờ reset rồi làm tiếp', 'Nghỉ trên sofa, tự làm tiếp đúng session cũ'],
            ['same', 'Chuyển tài khoản cùng loại', 'Claude → Claude khác, Codex → Codex khác'],
            ['any', 'Chuyển sang bất kỳ tài khoản còn hạn mức', 'Có thể đổi Claude ↔ Codex (giữ mức model)'],
          ] as const).map(([v, label, hint]) => (
            <label key={v} className={`radio ${o.settings.failover === v ? 'on' : ''}`}>
              <input type="radio" name="failover" checked={o.settings.failover === v} onChange={() => set({ failover: v })} />
              <span>
                <b>{label}</b>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="set-card">
        <h4>🪙 Tiết kiệm token</h4>
        <Toggle checked={o.settings.leanMode} onChange={(v) => set({ leanMode: v })} label="Chế độ gọn" hint="Bỏ MCP server khỏi phiên agent (~ −20% ngữ cảnh)" />
        <label className="field inline">
          Giao ca sang phiên mới khi ngữ cảnh vượt
          <select value={o.settings.rotateAtTokens} onChange={(e) => set({ rotateAtTokens: Number(e.target.value) })}>
            {[80_000, 120_000, 150_000, 250_000, 600_000].map((v) => <option key={v} value={v}>{fmtTokens(v)}</option>)}
          </select>
        </label>
        <div className="stats-grid">
          <div><b>{fmtTokens(totals.in)}</b><small>token mới</small></div>
          <div><b>{fmtTokens(totals.cached)}</b><small>từ cache</small></div>
          <div><b>{fmtTokens(totals.out)}</b><small>output</small></div>
          <div className={hit >= 80 ? 'good' : ''}><b>{hit}%</b><small>cache hit</small></div>
        </div>
      </section>

      <section className="set-card">
        <h4>🏢 Văn phòng</h4>
        <p className="muted small ellipsis" title={o.projectDir}>📁 {o.projectDir}{o.mainBranch ? ` · nhánh ${o.mainBranch}` : ''}</p>
        <div className="row">
          <button className="px-btn small" disabled={o.employees.length >= 6} onClick={() => api('office/add-staff', {})}>＋ Tuyển thêm</button>
          <button
            className="px-btn small danger"
            onClick={() => confirm('Đóng văn phòng này? Code và các nhánh git giữ nguyên, chỉ xóa trạng thái văn phòng.') && api('office/reset', {})}
          >
            Đóng văn phòng
          </button>
        </div>
      </section>
    </div>
  );
}
