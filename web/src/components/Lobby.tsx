import { useState } from 'react';
import { MAX_OFFICES, type AppSnapshot, type OfficeSummary, type OfficeType, type TemplateInfo } from '../../../shared/types';
import { api } from '../api';
import { getLang, t } from '../i18n';
import { Modal } from './ui';

const TYPE_TONE: Record<OfficeType, string> = { code: 'blue', video: 'red', other: 'green' };

/** The lobby: up to 6 offices, each bound to one project folder and one office type. */
export function Lobby({ snap }: { snap: AppSnapshot }) {
  const [creating, setCreating] = useState(false);
  const offices = snap.offices;
  const slots = Array.from({ length: MAX_OFFICES }, (_, i) => offices[i]);
  const tplOf = (id: OfficeType) => snap.templates.find((x) => x.id === id)!;
  const working = offices.reduce((n, o) => n + o.working, 0);

  return (
    <div className="lobby">
      <header className="lobby-head">
        <div>
          <span className="kicker">{t('LOBBY')}</span>
          <h1>{t('Your offices')}</h1>
          <p className="muted">{t('Up to {n} offices. Each office works in one project folder with its own lead and team.', { n: MAX_OFFICES })}</p>
        </div>
        <div className="lobby-stats">
          <div>
            <b>{offices.length}</b>
            <small>{t('offices')}</small>
          </div>
          <div className={working ? 'live' : ''}>
            <b>{working}</b>
            <small>{t('working now')}</small>
          </div>
        </div>
      </header>

      <div className="office-grid">
        {slots.map((o, i) =>
          o ? (
            <OfficeCard key={o.id} o={o} tpl={tplOf(o.template)} />
          ) : (
            <button key={`slot${i}`} className="office-card empty" onClick={() => setCreating(true)} disabled={offices.length >= MAX_OFFICES}>
              <span className="plus">＋</span>
              <b>{t('New office')}</b>
              <small>{t('Code office · more types coming soon')}</small>
            </button>
          ),
        )}
      </div>
      {creating && <CreateOffice templates={snap.templates} onClose={() => setCreating(false)} />}
    </div>
  );
}

function phaseLabel(o: OfficeSummary) {
  if (o.phase !== 'ready') return { text: t('Setting up'), tone: 'gold' };
  if (o.working) return { text: t('Working'), tone: 'green' };
  if (o.sleeping) return { text: t('Waiting for quota'), tone: 'blue' };
  return { text: t('Ready'), tone: 'default' };
}

function OfficeCard({ o, tpl }: { o: OfficeSummary; tpl: TemplateInfo }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(o.name);
  const [err, setErr] = useState('');
  const ph = phaseLabel(o);
  const text = tpl.i18n[getLang()];
  return (
    <article className={`office-card ${TYPE_TONE[o.template]} ${o.working ? 'live' : ''}`}>
      <div className="office-door" aria-hidden>
        <span className="office-icon">{tpl.icon}</span>
        {o.working > 0 && <span className="door-light" />}
      </div>
      <div className="office-body">
        <div className="row">
          {renaming ? (
            <form
              className="grow"
              onSubmit={async (e) => {
                e.preventDefault();
                await api('offices/rename', { id: o.id, name });
                setRenaming(false);
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} maxLength={40} />
            </form>
          ) : (
            <b className="office-name grow ellipsis" title={o.name}>{o.name}</b>
          )}
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label={t('More')}>⋯</button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setRenaming(true); setMenu(false); }}>✏️ {t('Rename')}</button>
              <button
                className="danger"
                onClick={async () => {
                  setMenu(false);
                  if (!confirm(t('Close office "{name}"? Project files and git branches are kept; only the office state is removed.', { name: o.name }))) return;
                  try {
                    await api('offices/delete', { id: o.id });
                  } catch (x: any) {
                    setErr(x.message);
                  }
                }}
              >
                🗑 {t('Close office')}
              </button>
            </div>
          )}
        </div>
        <span className="office-type">{text.name}</span>
        <span className="office-folder ellipsis" title={o.projectDir}>
          📁 {o.projectDir ? o.projectDir.split(/[\\/]/).pop() : t('No folder yet')}
          {o.mainBranch && <span className="muted"> · ⎇ {o.mainBranch}</span>}
        </span>
        <div className="office-meta">
          <span className={`pill ${ph.tone}`}>{ph.text}</span>
          <span title={t('Employees')}>👥 {o.employees}</span>
          {o.working > 0 && <span className="live-text">⌨️ {o.working}</span>}
          {o.sleeping > 0 && <span className="sleep-text">😴 {o.sleeping}</span>}
          {(o.openTasks > 0 || o.doneTasks > 0) && (
            <span title={t('Tasks done / total')}>📋 {o.doneTasks}/{o.doneTasks + o.openTasks}</span>
          )}
        </div>
        {err && <p className="error">{err}</p>}
        <button className="px-btn primary enter" onClick={() => api('offices/open', { id: o.id })}>
          {t('Enter office')} →
        </button>
      </div>
    </article>
  );
}

function CreateOffice({ templates, onClose }: { templates: TemplateInfo[]; onClose: () => void }) {
  const [type, setType] = useState<OfficeType>('code');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const lang = getLang();
  return (
    <Modal title={t('New office')} icon="🏢" onClose={onClose} wide>
      <p className="muted">{t('Pick what this office is for. The lead reads your project first, then proposes a team that fits this kind of work.')}</p>
      <div className="type-grid">
        {templates.map((tp) => {
          const x = tp.i18n[lang];
          return (
            <button
              key={tp.id}
              className={`type-card ${TYPE_TONE[tp.id]} ${type === tp.id ? 'on' : ''} ${tp.locked ? 'locked' : ''}`}
              disabled={tp.locked}
              aria-disabled={tp.locked}
              onClick={() => !tp.locked && setType(tp.id)}
            >
              {tp.locked && (
                <span className="lock-overlay">
                  <span className="padlock" aria-hidden />
                  <b>{t('Coming soon')}</b>
                </span>
              )}
              <span className="type-icon">{tp.icon}</span>
              <b>{x.name}</b>
              <small className="muted">{x.tagline}</small>
              <ul className="can">
                {x.can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <ul className="cannot">
                {x.cannot.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      <label className="field">
        {t('Office name')}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={templates.find((x) => x.id === type)?.i18n[lang].name} maxLength={40} />
      </label>
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn" onClick={onClose}>{t('Cancel')}</button>
        <button
          className="px-btn primary big"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('offices/create', { type, name });
            } catch (x: any) {
              setErr(x.message);
              setBusy(false);
            }
          }}
        >
          {t('Create & enter')} →
        </button>
      </div>
    </Modal>
  );
}
