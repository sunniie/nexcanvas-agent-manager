import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Capability, Employee, LogEntry } from '../../shared/types';
import { api, onBubble, useSnapshot } from './api';
import { getLang, setLang, t } from './i18n';
import { OfficeEngine } from './office/engine';
import { AccountHud } from './components/AccountHud';
import { Setup } from './components/Setup';
import { CAP_LABEL, Workspace } from './components/Workspace';
import { EMP_STATUS, EmployeeDialog } from './components/EmployeeDialog';
import { Lobby } from './components/Lobby';
import { ReportBoard } from './components/ReportBoard';
import { LanguagePicker, LanguageSwitch } from './components/LanguagePicker';
import { Avatar, Modal, ProviderIcon } from './components/ui';

const STAGE_TITLE = { code: 'CODE OFFICE', video: 'VIDEO STUDIO', other: 'OPEN OFFICE' } as const;

export function App() {
  const { snap, connected } = useSnapshot();
  const [openEmp, setOpenEmp] = useState<string>();
  if (snap?.language && snap.language !== getLang()) setLang(snap.language);
  useEffect(() => {
    setOpenEmp(undefined);
  }, [snap?.office?.id]);

  if (!snap) {
    return (
      <div className="boot">
        <div className="logo-big">▣</div>
        <b>NEXCANVAS</b>
        <p>{connected ? t('Opening the office…') : t('Connecting to the local server…')}</p>
      </div>
    );
  }
  if (!snap.language) return <LanguagePicker />;

  const o = snap.office;
  const tpl = o && snap.templates.find((x) => x.id === o.template);
  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => o && api('offices/close', {})} title={t('Back to the lobby')}>
          <span className="logo">▣</span>
          <span>
            <b>NEXCANVAS</b>
            <small>{o ? `${o.name}${o.mainBranch ? ` · ⎇ ${o.mainBranch}` : ''}` : t('Lobby')}</small>
          </span>
        </button>
        {o && (
          <button className="lobby-btn" onClick={() => api('offices/close', {})}>
            ← {t('Offices')}
            <span className="lobby-count">{snap.offices.length}</span>
          </button>
        )}
        <AccountHud snap={snap} />
        <LanguageSwitch current={snap.language} />
        <span className={`conn ${connected ? 'on' : ''}`} title={connected ? t('Connected') : t('Disconnected — retrying')} />
      </header>
      {!o ? (
        <main className="lobby-main">
          <Lobby snap={snap} />
        </main>
      ) : (
        <main className="main">
          <section className="stage-col">
            <OfficeStage snap={snap} selected={openEmp} onPick={setOpenEmp} title={tpl?.icon ? `${tpl.icon} ${STAGE_TITLE[o.template]}` : STAGE_TITLE[o.template]} />
            <StaffDock snap={snap} selected={openEmp} onPick={setOpenEmp} />
          </section>
          <aside className="side frame">{o.phase === 'ready' ? <Workspace snap={snap} onOpenEmployee={setOpenEmp} /> : <Setup snap={snap} />}</aside>
        </main>
      )}
      {o && openEmp && <EmployeeDialog snap={snap} id={openEmp} onClose={() => setOpenEmp(undefined)} />}
      {o?.pendingPermission && <PermissionDialog snap={snap} />}
      {o && <Toasts officeId={o.id} log={o.log} staff={[o.coordinator, ...o.employees].filter(Boolean) as Employee[]} />}
    </div>
  );
}

// ---------- office stage ----------

function OfficeStage({ snap, selected, onPick, title }: { snap: AppSnapshot; selected?: string; onPick: (id: string) => void; title: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<OfficeEngine | undefined>(undefined);
  const lastLog = useRef(0);
  const officeId = snap.office!.id;
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();
  const [view, setView] = useState<'office' | 'board'>('office');
  useEffect(() => setView('office'), [officeId]);

  useEffect(() => {
    const e = new OfficeEngine(canvas.current!);
    engine.current = e;
    const ro = new ResizeObserver(([entry]) => e.resize(entry.contentRect.width, entry.contentRect.height));
    ro.observe(wrap.current!);
    return () => {
      ro.disconnect();
      e.destroy();
    };
  }, []);

  useEffect(() => {
    const off = onBubble((oid, id, text) => {
      if (oid === officeId) engine.current?.say(id, text);
    });
    lastLog.current = Date.now();
    return () => void off();
  }, [officeId]);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.setSnapshot(snap);
    // Speech lines from the office log become bubbles above the speaker.
    for (const l of snap.office!.log) {
      if (l.at <= lastLog.current || l.kind !== 'speech') continue;
      if (Date.now() - l.at < 15000) e.say(l.who, l.text.replace(/\*\*/g, '').split('\n')[0], 6500);
    }
    lastLog.current = Math.max(lastLog.current, snap.office!.log.at(-1)?.at ?? 0);
  }, [snap]);

  useEffect(() => {
    if (engine.current) engine.current.selected = selected;
  }, [selected]);

  const o = snap.office!;
  const staff = [o.coordinator, ...o.employees].filter(Boolean) as Employee[];
  const working = staff.filter((e) => e.status === 'working').length;
  const sleeping = staff.filter((e) => e.status === 'sleeping').length;
  const hoverEmp = hover && staff.find((e) => e.id === hover.id);
  const doneCount = o.tasks.filter((x) => x.status === 'done').length;

  return (
    <div className="stage frame">
      <div className="stage-bar">
        <span className="stage-title">{title}</span>
        {o.phase === 'ready' && (
          <span className="view-switch" role="tablist">
            <button role="tab" aria-selected={view === 'office'} className={view === 'office' ? 'on' : ''} onClick={() => setView('office')}>
              🏢 {t('Office')}
            </button>
            <button role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
              📌 {t('Report board')}
              {doneCount > 0 && <span className="view-count">{doneCount}</span>}
            </button>
          </span>
        )}
        <span className="stage-stats">
          <span title={t('Employees')}>👥 {o.employees.length}/6</span>
          {working > 0 && <span className="working">⌨️ {t('{n} working', { n: working })}</span>}
          {sleeping > 0 && <span className="sleeping">😴 {t('{n} napping', { n: sleeping })}</span>}
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
            <b>
              {hoverEmp.name} · {hoverEmp.title}
            </b>
            <small>{snap.busy[hoverEmp.id] ?? hoverEmp.statusText ?? t(EMP_STATUS[hoverEmp.status])}</small>
            <small className="muted">
              {hoverEmp.model} · {t('click to open the profile')}
            </small>
          </div>
        )}
        {view === 'board' && o.phase === 'ready' && <ReportBoard snap={snap} />}
        {!o.coordinator && (
          <div className="stage-empty">
            <b>{t('The office is empty')}</b>
            <span>{t('Choose a lead on the right to get started →')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- staff dock ----------

function StaffDock({ snap, selected, onPick }: { snap: AppSnapshot; selected?: string; onPick: (id: string) => void }) {
  const o = snap.office!;
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
          <small className={`dock-status ${e.status}`}>{activity ?? e.statusText ?? t(EMP_STATUS[e.status])}</small>
        </span>
      </button>
    );
  };
  return (
    <div className="dock">
      {o.coordinator ? card(o.coordinator) : <div className="dock-card ghost lead">★ {t('Lead')}</div>}
      {slots.map((e, i) =>
        e ? (
          card(e)
        ) : (
          <button key={`slot${i}`} className="dock-card ghost" disabled={!canHire} onClick={() => api('office/add-staff', {})} title={canHire ? t('Hire another employee') : t('Empty desk')}>
            {canHire ? `＋ ${t('Hire')}` : t('Empty desk')}
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

function toastFor(l: LogEntry, name: (id: string) => string): Omit<Toast, 'id'> | undefined {
  const strip = (s: string) => s.replace(/^\S+\s/, '').replace(/\*\*/g, '');
  if (l.kind === 'error') return { tone: 'red', icon: '⚠', title: name(l.who), text: l.text };
  switch (l.tag) {
    case 'report':
      return { tone: 'gold', icon: '📣', title: t('Report from the lead'), text: l.text.replace(/\*\*/g, '') };
    case 'sleep':
      return { tone: 'blue', icon: '😴', title: t('{name} is napping', { name: name(l.who) }), text: strip(l.text) };
    case 'failover':
      return { tone: 'blue', icon: '🔄', title: t('{name} switched accounts', { name: name(l.who) }), text: strip(l.text) };
    case 'merge':
      return { tone: 'green', icon: '🔀', title: t('Code merged'), text: strip(l.text) };
    case 'conflict':
      return { tone: 'red', icon: '⚔️', title: t('Merge conflict'), text: strip(l.text) };
    case 'done':
      return { tone: 'green', icon: '✅', title: t('{name} finished a task', { name: name(l.who) }), text: strip(l.text) };
    default:
      return undefined;
  }
}

function Toasts({ officeId, log, staff }: { officeId: string; log: LogEntry[]; staff: Employee[] }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(Date.now());
  useEffect(() => {
    seen.current = Date.now();
    setToasts([]);
  }, [officeId]);
  useEffect(() => {
    const fresh = log.filter((l) => l.at > seen.current);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1].at;
    const name = (id: string) => (id === 'system' ? t('System') : staff.find((e) => e.id === id)?.name ?? id);
    const add = fresh
      .map((l) => toastFor(l, name))
      .filter(Boolean)
      .map((x, i) => ({ ...x!, id: Date.now() + i }));
    if (!add.length) return;
    setToasts((cur) => [...cur, ...add].slice(-4));
    for (const x of add) setTimeout(() => setToasts((cur) => cur.filter((y) => y.id !== x.id)), x.tone === 'gold' ? 9000 : 5500);
  }, [log]);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.tone}`} onClick={() => setToasts((c) => c.filter((y) => y.id !== x.id))}>
          <span className="toast-icon">{x.icon}</span>
          <div>
            <b>{x.title}</b>
            <p>{x.text.length > 140 ? x.text.slice(0, 140) + '…' : x.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- permission ----------

function PermissionDialog({ snap }: { snap: AppSnapshot }) {
  const p = snap.office!.pendingPermission!;
  const [caps, setCaps] = useState<Capability[]>(p.needs);
  return (
    <Modal title={t('The lead asks for permission')} icon="🔐" onClose={() => {}}>
      <p className="perm-reason">{p.reason}</p>
      <div className="perm-list">
        {p.needs.map((c) => (
          <label key={c} className={`perm ${caps.includes(c) ? 'on' : ''} ${c === 'full_access' ? 'danger' : ''}`}>
            <input type="checkbox" checked={caps.includes(c)} onChange={(e) => setCaps(e.target.checked ? [...caps, c] : caps.filter((x) => x !== c))} />
            {t(CAP_LABEL[c] ?? c)}
          </label>
        ))}
      </div>
      <p className="muted small">{t('Granted once, the office reuses it for every later task in this project. You can revoke it in Settings.')}</p>
      <div className="actions">
        <button className="px-btn" onClick={() => api('permissions/deny', {})}>{t('Deny this task')}</button>
        <button className="px-btn primary" disabled={!caps.length} onClick={() => api('permissions/grant', { caps })}>
          {t('Grant')}
        </button>
      </div>
    </Modal>
  );
}
