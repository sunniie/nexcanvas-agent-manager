import { useEffect, useRef, useState } from 'react';
import { CAPABILITY_LABELS, type AppSnapshot, type Capability, type Employee, type LogEntry } from '../../shared/types';
import { api, onBubble, useSnapshot } from './api';
import { OfficeEngine } from './office/engine';
import { AccountHud } from './components/AccountHud';
import { Setup } from './components/Setup';
import { Workspace } from './components/Workspace';
import { EmployeeDialog } from './components/EmployeeDialog';
import { Avatar, Modal, ProviderIcon } from './components/ui';

export function App() {
  const { snap, connected } = useSnapshot();
  const [openEmp, setOpenEmp] = useState<string>();

  if (!snap) {
    return (
      <div className="boot">
        <div className="logo-big">▣</div>
        <b>NEXCANVAS OFFICE</b>
        <p>{connected ? 'Đang mở văn phòng…' : 'Đang kết nối máy chủ cục bộ…'}</p>
      </div>
    );
  }
  const o = snap.office;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▣</span>
          <div>
            <b>NEXCANVAS</b>
            <small>{o.projectDir ? o.projectDir.split(/[\\/]/).pop() : 'Văn phòng Code'}{o.mainBranch ? ` · ⎇ ${o.mainBranch}` : ''}</small>
          </div>
        </div>
        <AccountHud snap={snap} />
        <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Đã kết nối' : 'Mất kết nối — đang thử lại'} />
      </header>
      <main className="main">
        <section className="stage-col">
          <OfficeStage snap={snap} selected={openEmp} onPick={setOpenEmp} />
          <StaffDock snap={snap} selected={openEmp} onPick={setOpenEmp} />
        </section>
        <aside className="side frame">{o.phase === 'ready' ? <Workspace snap={snap} onOpenEmployee={setOpenEmp} /> : <Setup snap={snap} />}</aside>
      </main>
      {openEmp && <EmployeeDialog snap={snap} id={openEmp} onClose={() => setOpenEmp(undefined)} />}
      {o.pendingPermission && <PermissionDialog snap={snap} />}
      <Toasts log={o.log} />
    </div>
  );
}

// ---------- office stage ----------

function OfficeStage({ snap, selected, onPick }: { snap: AppSnapshot; selected?: string; onPick: (id: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<OfficeEngine | undefined>(undefined);
  const lastLog = useRef(0);
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();

  useEffect(() => {
    const e = new OfficeEngine(canvas.current!);
    engine.current = e;
    const ro = new ResizeObserver(([entry]) => e.resize(entry.contentRect.width, entry.contentRect.height));
    ro.observe(wrap.current!);
    const off = onBubble((id, text) => e.say(id, text));
    return () => {
      ro.disconnect();
      off();
      e.destroy();
    };
  }, []);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.setSnapshot(snap);
    const staff = [snap.office.coordinator, ...snap.office.employees].filter(Boolean);
    for (const l of snap.office.log) {
      if (l.at <= lastLog.current || l.kind !== 'speech') continue;
      const who = staff.find((s) => s!.name === l.who);
      if (who && Date.now() - l.at < 15000) e.say(who.id, l.text.replace(/\*\*/g, '').split('\n')[0], 6500);
    }
    lastLog.current = snap.office.log.at(-1)?.at ?? lastLog.current;
  }, [snap]);

  useEffect(() => {
    if (engine.current) engine.current.selected = selected;
  }, [selected]);

  const o = snap.office;
  const staff = [o.coordinator, ...o.employees].filter(Boolean) as Employee[];
  const working = staff.filter((e) => e.status === 'working').length;
  const sleeping = staff.filter((e) => e.status === 'sleeping').length;
  const hoverEmp = hover && staff.find((e) => e.id === hover.id);

  return (
    <div className="stage frame">
      <div className="stage-bar">
        <span className="stage-title">CODE OFFICE</span>
        <span className="stage-stats">
          <span title="Nhân sự">👥 {o.employees.length}/6</span>
          {working > 0 && <span className="working" title="Đang làm việc">⌨️ {working} đang làm</span>}
          {sleeping > 0 && <span className="sleeping" title="Chờ hạn mức">😴 {sleeping} đang nghỉ</span>}
        </span>
      </div>
      <div className="stage-canvas" ref={wrap}>
        <canvas
          ref={canvas}
          onClick={(ev) => {
            const id = engine.current?.pick(ev.clientX, ev.clientY);
            if (id) onPick(id);
          }}
          onMouseMove={(ev) => {
            const e = engine.current;
            if (!e) return;
            const id = e.pick(ev.clientX, ev.clientY);
            e.hover = id;
            (ev.target as HTMLCanvasElement).style.cursor = id ? 'pointer' : 'default';
            const a = id && e.anchorOf(id);
            setHover(a ? { id: id!, x: a.x, y: a.y } : undefined);
          }}
          onMouseLeave={() => {
            if (engine.current) engine.current.hover = undefined;
            setHover(undefined);
          }}
        />
        {hoverEmp && hover && (
          <div className="tip" style={{ left: hover.x, top: hover.y }}>
            <b>{hoverEmp.name}</b> · {hoverEmp.title}
            <small>{snap.busy[hoverEmp.id] ?? hoverEmp.statusText ?? STATUS_TEXT[hoverEmp.status]}</small>
            <small className="muted">{hoverEmp.model} · bấm để mở hồ sơ</small>
          </div>
        )}
        {!o.coordinator && (
          <div className="stage-empty">
            <b>Văn phòng đang trống</b>
            <span>Chọn Trưởng phòng ở bảng bên phải để bắt đầu →</span>
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<Employee['status'], string> = {
  'walking-in': 'Đang vào văn phòng',
  idle: 'Đang rảnh',
  working: 'Đang làm việc',
  sleeping: 'Nghỉ chờ hạn mức',
  blocked: 'Bị chặn',
  meeting: 'Đang họp',
};

// ---------- staff dock ----------

function StaffDock({ snap, selected, onPick }: { snap: AppSnapshot; selected?: string; onPick: (id: string) => void }) {
  const o = snap.office;
  const accounts = new Map(snap.accounts.map((a) => [a.id, a]));
  const slots = Array.from({ length: 6 }, (_, i) => o.employees.find((e) => e.desk === i));
  const canHire = o.phase === 'ready' && o.employees.length < 6;
  const card = (e: Employee) => {
    const acc = accounts.get(e.accountId);
    const activity = snap.busy[e.id];
    return (
      <button key={e.id} className={`dock-card ${e.status} ${selected === e.id ? 'sel' : ''} ${e.isCoordinator ? 'lead' : ''}`} onClick={() => onPick(e.id)} style={{ ['--badge' as any]: acc?.color }}>
        <Avatar e={e} size={36} />
        <span className="dock-info">
          <b>
            {e.isCoordinator && <span className="star">★</span>}
            {e.name}
          </b>
          <small className="dock-role">{e.title}</small>
          <span className="dock-model">
            {acc && <ProviderIcon provider={acc.provider} size={12} />}
            {e.model.replace(/\[.*\]$/, '')}
          </span>
          <small className={`dock-status ${e.status}`}>{activity ?? e.statusText ?? STATUS_TEXT[e.status]}</small>
        </span>
      </button>
    );
  };
  return (
    <div className="dock">
      {o.coordinator ? card(o.coordinator) : <div className="dock-card ghost lead">★ Trưởng phòng</div>}
      {slots.map((e, i) =>
        e ? (
          card(e)
        ) : (
          <button key={`slot${i}`} className="dock-card ghost" disabled={!canHire} onClick={() => api('office/add-staff', {})} title={canHire ? 'Tuyển thêm nhân viên' : 'Bàn trống'}>
            {canHire ? '＋ Tuyển' : 'Bàn trống'}
          </button>
        ),
      )}
    </div>
  );
}

// ---------- toasts ----------

interface Toast {
  id: number;
  tone: string;
  icon: string;
  title: string;
  text: string;
}

function toastFor(l: LogEntry): Omit<Toast, 'id'> | undefined {
  const t = l.text;
  if (l.kind === 'error') return { tone: 'red', icon: '⚠', title: l.who, text: t };
  if (t.startsWith('📣')) return { tone: 'gold', icon: '📣', title: 'Báo cáo từ Trưởng phòng', text: t.replace(/^📣\s*Báo cáo:\s*/, '').replace(/\*\*/g, '') };
  if (t.startsWith('😴')) return { tone: 'blue', icon: '😴', title: `${l.who} đang nghỉ`, text: t.slice(2) };
  if (t.startsWith('🔄')) return { tone: 'blue', icon: '🔄', title: `${l.who} đổi tài khoản`, text: t.slice(2) };
  if (t.startsWith('🔀')) return { tone: 'green', icon: '🔀', title: 'Đã gộp code', text: t.slice(2) };
  if (t.startsWith('⚔️')) return { tone: 'red', icon: '⚔️', title: 'Xung đột code', text: t.slice(2) };
  if (t.startsWith('✅')) return { tone: 'green', icon: '✅', title: `${l.who} xong việc`, text: t.slice(2) };
  return undefined;
}

function Toasts({ log }: { log: LogEntry[] }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(Date.now());
  useEffect(() => {
    const fresh = log.filter((l) => l.at > seen.current);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1].at;
    const add = fresh.map(toastFor).filter(Boolean).map((t, i) => ({ ...t!, id: Date.now() + i }));
    if (!add.length) return;
    setToasts((cur) => [...cur, ...add].slice(-4));
    for (const t of add) setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), t.tone === 'gold' ? 9000 : 5500);
  }, [log]);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => setToasts((c) => c.filter((x) => x.id !== t.id))}>
          <span className="toast-icon">{t.icon}</span>
          <div>
            <b>{t.title}</b>
            <p>{t.text.length > 140 ? t.text.slice(0, 140) + '…' : t.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- permission ----------

function PermissionDialog({ snap }: { snap: AppSnapshot }) {
  const p = snap.office.pendingPermission!;
  const [caps, setCaps] = useState<Capability[]>(p.needs);
  return (
    <Modal title="Trưởng phòng xin quyền" icon="🔐" onClose={() => {}}>
      <p className="perm-reason">{p.reason}</p>
      <div className="perm-list">
        {p.needs.map((c) => (
          <label key={c} className={`perm ${caps.includes(c) ? 'on' : ''} ${c === 'full_access' ? 'danger' : ''}`}>
            <input type="checkbox" checked={caps.includes(c)} onChange={(e) => setCaps(e.target.checked ? [...caps, c] : caps.filter((x) => x !== c))} />
            {CAPABILITY_LABELS[c] ?? c}
          </label>
        ))}
      </div>
      <p className="muted small">Cấp một lần, văn phòng dùng cho mọi task sau của dự án. Thu hồi được ở tab Thiết lập.</p>
      <div className="actions">
        <button className="px-btn" onClick={() => api('permissions/deny', {})}>Từ chối task này</button>
        <button className="px-btn primary" disabled={!caps.length} onClick={() => api('permissions/grant', { caps })}>Cấp quyền</button>
      </div>
    </Modal>
  );
}
