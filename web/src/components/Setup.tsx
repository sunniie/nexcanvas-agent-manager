import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSnapshot, PastSession, Provider, SkillInfo } from '../../../shared/types';
import { api, fmtTime, onBubble } from '../api';
import { getLang, locale, t } from '../i18n';
import { FolderBrowser } from './FolderBrowser';
import { Pill, ProviderIcon, StatBar, tierLabel } from './ui';

export interface HireSpec {
  roleKey: string;
  title: string;
  provider: Provider;
  accountId: string;
  model: string;
  effort: string;
  skills: string[];
  name?: string;
}

const STEPS: [string, string][] = [
  ['choose-coordinator', 'Lead'],
  ['choose-folder', 'Project'],
  ['context', 'Context'],
  ['proposal', 'Team'],
  ['staffing', 'Staffing'],
];

export function Setup({ snap }: { snap: AppSnapshot }) {
  const o = snap.office!;
  const phase = o.phase;
  const idx = phase === 'analyzing' ? 2.5 : STEPS.findIndex(([k]) => k === phase);
  const rehiring = phase === 'staffing' && o.employees.length > 0;
  return (
    <div className="setup">
      {!rehiring && (
        <ol className="steps" aria-label={t('Setup steps')}>
          {STEPS.map(([k, label], i) => (
            <li key={k} className={i < idx ? 'done' : Math.ceil(idx) === i ? 'cur' : ''}>
              <span className="node">{i < idx ? '✓' : i + 1}</span>
              <span className="lbl">{t(label)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="setup-body">
        {phase === 'choose-coordinator' && <ChooseCoordinator snap={snap} />}
        {phase === 'choose-folder' && <ChooseFolder snap={snap} />}
        {phase === 'context' && <ContextStep snap={snap} />}
        {phase === 'analyzing' && <Analyzing snap={snap} />}
        {phase === 'proposal' && <ProposalStep snap={snap} />}
        {phase === 'staffing' && <Staffing snap={snap} />}
      </div>
    </div>
  );
}

function useErr() {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const wrap = (fn: () => Promise<unknown>) => async () => {
    setErr('');
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { err, busy, wrap };
}

function StepHead({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <header className="step-head">
      <span className="kicker">{kicker}</span>
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
    </header>
  );
}

// ---------- 1. lead ----------

function ChooseCoordinator({ snap }: { snap: AppSnapshot }) {
  const [provider, setProvider] = useState<Provider>();
  const [accountId, setAccountId] = useState('');
  const [model, setModel] = useState('');
  const { err, busy, wrap } = useErr();
  const accs = snap.accounts.filter((a) => a.provider === provider);
  const tpl = snap.templates.find((x) => x.id === snap.office!.template)!;

  useEffect(() => {
    if (!provider) return;
    const first = snap.accounts.find((a) => a.provider === provider && a.loggedIn);
    setAccountId(first?.id ?? '');
    setModel(snap.models[provider].find((m) => m.tier === 'high')?.id ?? snap.models[provider][0]?.id ?? '');
  }, [provider]);

  return (
    <section>
      <StepHead
        kicker={t('STEP {n}', { n: 1 })}
        title={t('Choose the lead')}
        sub={t('The lead of your {office} reads the project, proposes a team, splits the work, reviews it and reports back to you.', { office: tpl.i18n[getLang()].name })}
      />
      <div className="pick-grid">
        {(['claude', 'codex'] as Provider[]).map((p) => {
          const list = snap.accounts.filter((a) => a.provider === p);
          const ok = list.some((a) => a.loggedIn);
          const main = list.find((a) => a.loggedIn) ?? list[0];
          return (
            <button key={p} className={`pick-card ${provider === p ? 'on' : ''}`} disabled={!ok} onClick={() => setProvider(p)}>
              {provider === p && <span className="check">✓</span>}
              <ProviderIcon provider={p} size={40} />
              <b>{p === 'claude' ? 'Claude Code' : 'Codex'}</b>
              <small>{ok ? main?.displayName ?? main?.email ?? t('Signed in') : t('Not signed in')}</small>
              {main?.plan && <Pill>{main.plan.toUpperCase()}</Pill>}
              {main?.loggedIn && (
                <div className="mini-stats">
                  <StatBar label="5H" kind="hp" usedPercent={main.usage?.fiveHour?.usedPercent} resetsAt={main.usage?.fiveHour?.resetsAt} compact />
                  <StatBar label="7D" kind="mp" usedPercent={main.usage?.weekly?.usedPercent} resetsAt={main.usage?.weekly?.resetsAt} compact />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {provider && (
        <div className="reveal">
          {accs.length > 1 && (
            <label className="field">
              {t('Account')}
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accs.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.loggedIn}>
                    {a.label} {a.email ? `· ${a.email}` : ''} {a.loggedIn ? '' : `(${t('Not signed in')})`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field">
            {t('Model for the lead')}
            <div className="model-list">
              {snap.models[provider].slice(0, 5).map((m) => (
                <button key={m.id} className={`model-opt ${model === m.id ? 'on' : ''}`} onClick={() => setModel(m.id)}>
                  <b>{m.label.replace(/\s*\(.*\)$/, '')}</b>
                  <span className={`tier ${m.tier}`}>{tierLabel(m.tier)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={!provider || !accountId || busy} onClick={wrap(() => api('office/coordinator', { provider, accountId, model }))}>
          {t('Appoint the lead')} →
        </button>
      </div>
    </section>
  );
}

// ---------- 2. folder ----------

function ChooseFolder({ snap }: { snap: AppSnapshot }) {
  const [path, setPath] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [picking, setPicking] = useState(false);
  const { err, busy, wrap } = useErr();
  useEffect(() => {
    api<string[]>('recent').then(setRecent).catch(() => {});
  }, []);
  const taken = new Map(snap.offices.filter((o) => o.projectDir && o.id !== snap.office!.id).map((o) => [o.projectDir!.toLowerCase(), o.name]));
  const native = async () => {
    setPicking(true);
    try {
      const r = await api<{ path?: string }>('fs/pick', { title: t('Choose a project folder') });
      if (r.path) setPath(r.path);
    } finally {
      setPicking(false);
    }
  };
  return (
    <section>
      <StepHead kicker={t('STEP {n}', { n: 2 })} title={t('Which project does this office work on?')} sub={t('The office keeps its notes in a .office/ folder inside the project (excluded from git).')} />
      <div className="folder-pick">
        <button className="drop-card" onClick={native} disabled={picking}>
          <span className="folder-icon" aria-hidden />
          <b>{path ? path.split(/[\\/]/).pop() : picking ? t('Waiting for the folder dialog…') : t('Open folder picker…')}</b>
          <small>{path || t('Opens your system’s “Select folder” window')}</small>
        </button>
        <button className="px-btn small" onClick={() => setBrowsing(true)}>🗂 {t('Browse here instead')}</button>
      </div>
      <label className="field">
        {t('or paste a path')}
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\...\my-project" />
      </label>
      {recent.length > 0 && (
        <div className="recent">
          <span className="field-label">{t('Recent')}</span>
          {recent.map((r) => {
            const owner = taken.get(r.toLowerCase());
            return (
              <button key={r} className={`recent-item ${r === path ? 'on' : ''}`} onClick={() => setPath(r)} disabled={!!owner}>
                <span className="folder-icon small" aria-hidden />
                <span className="ellipsis">
                  <b>{r.split(/[\\/]/).pop()}</b>
                  <small>{owner ? t('Used by office “{name}”', { name: owner }) : r}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={!path.trim() || busy} onClick={wrap(() => api('office/folder', { path: path.trim() }))}>
          {t('Enter the office')} →
        </button>
      </div>
      {browsing && (
        <FolderBrowser
          start={path || recent[0]}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            setPath(p);
            setBrowsing(false);
          }}
        />
      )}
    </section>
  );
}

// ---------- 3. context ----------

function ContextStep({ snap }: { snap: AppSnapshot }) {
  const [sessions, setSessions] = useState<PastSession[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [exportPrompt, setExportPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<'auto' | 'file' | 'prompt' | ''>('auto');
  const { err, busy, wrap } = useErr();

  useEffect(() => {
    api<PastSession[]>('context/sessions').then(setSessions).catch(() => setSessions([]));
    api<{ prompt: string }>('context/export-prompt').then((r) => setExportPrompt(r.prompt));
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) await api('context/upload', { name: f.name, content: await f.text() });
  };
  const files = snap.office!.contextFiles;

  return (
    <section>
      <StepHead kicker={t('STEP {n}', { n: 3 })} title={t('Project context')} sub={t('Helps the lead understand what you discussed before. Optional.')} />

      <div className={`acc-item ${open === 'auto' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'auto' ? '' : 'auto')}>
          <span>⚡</span>
          <b>{t('Previous chat sessions on this machine')}</b>
          <Pill tone={sessions?.length ? 'green' : 'default'}>{sessions ? t('{n} session(s)', { n: sessions.length }) : '…'}</Pill>
        </button>
        {open === 'auto' && (
          <div className="acc-item-body">
            {!sessions ? (
              <p className="muted">{t('Searching…')}</p>
            ) : sessions.length === 0 ? (
              <p className="muted">{t('No Claude Code / Codex sessions were found for this folder.')}</p>
            ) : (
              <>
                <div className="session-list">
                  {sessions.slice(0, 12).map((s) => (
                    <label key={s.id} className={`session ${picked.has(s.id) ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(s.id);
                          else n.delete(s.id);
                          setPicked(n);
                        }}
                      />
                      <ProviderIcon provider={s.provider} size={16} />
                      <span className="grow ellipsis" title={s.title}>{s.title}</span>
                      <small className="muted">{new Date(s.updatedAt).toLocaleDateString(locale())}</small>
                    </label>
                  ))}
                </div>
                <button
                  className="px-btn small"
                  disabled={!picked.size || busy}
                  onClick={wrap(async () => {
                    await api('context/import', { ids: [...picked] });
                    setPicked(new Set());
                  })}
                >
                  {t('Import {n} session(s)', { n: picked.size || '' })}
                </button>
                <small className="muted hint">{t('Condensed locally (tool calls removed) — no tokens spent.')}</small>
              </>
            )}
          </div>
        )}
      </div>

      <div className={`acc-item ${open === 'file' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'file' ? '' : 'file')}>
          <span>📄</span>
          <b>{t('Upload .txt / .md files')}</b>
        </button>
        {open === 'file' && (
          <div className="acc-item-body">
            <label className="upload-zone">
              <input type="file" accept=".txt,.md,text/plain" multiple hidden onChange={(e) => upload(e.target.files)} />
              <b>⬆ {t('Choose files')}</b>
              <small>{t('Notes, requirements, handover documents…')}</small>
            </label>
          </div>
        )}
      </div>

      <div className={`acc-item ${open === 'prompt' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'prompt' ? '' : 'prompt')}>
          <span>📋</span>
          <b>{t('Export from an old chat (manual)')}</b>
        </button>
        {open === 'prompt' && (
          <div className="acc-item-body">
            <ol className="manual">
              <li>{t('Copy the handover prompt below')}</li>
              <li>{t('Paste it into the old chat (Claude, ChatGPT…)')}</li>
              <li>{t('Save the answer as .txt and upload it above')}</li>
            </ol>
            <pre className="prompt-box">{exportPrompt}</pre>
            <button
              className="px-btn small"
              onClick={async () => {
                await navigator.clipboard.writeText(exportPrompt);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? `✓ ${t('Copied')}` : t('Copy prompt')}
            </button>
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="file-list">
          <span className="field-label">{t('Attached ({n})', { n: files.length })}</span>
          {files.map((f) => (
            <span key={f} className="file-chip">
              📄 <span className="ellipsis">{f}</span>
              <button onClick={() => api('context/remove', { name: f })} aria-label={t('Remove {name}', { name: f })}>✕</button>
            </span>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={busy} onClick={wrap(() => api('office/analyze', {}))}>
          {files.length ? t('Analyze the project') : t('Skip, analyze now')} →
        </button>
      </div>
    </section>
  );
}

function Analyzing({ snap }: { snap: AppSnapshot }) {
  const [feed, setFeed] = useState<string[]>([]);
  const ref = useRef<HTMLUListElement>(null);
  const officeId = snap.office!.id;
  useEffect(() => {
    const off = onBubble((oid, id, text) => {
      if (oid === officeId && id === 'lead') setFeed((f) => [...f.slice(-7), text]);
    });
    return () => void off();
  }, [officeId]);
  useEffect(() => {
    // braces matter: newer Chromium returns a Promise from scrollTo, and React would call it as a cleanup
    ref.current?.scrollTo({ top: 9999 });
  }, [feed]);
  const job = snap.office!.jobs.find((j) => j.employeeId === 'lead' && ['running', 'queued', 'waiting_quota'].includes(j.status));
  return (
    <section className="analyzing">
      <div className="reading-anim" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <h2>{t('The lead is reading the project…')}</h2>
      <p className="muted">{t('Nobody is hired until the lead understands the project.')}</p>
      {job?.status === 'waiting_quota' && <p className="warn">😴 {t('Out of quota — retries automatically at {time}', { time: fmtTime(job.resumeAt!) })}</p>}
      <ul className="feed" ref={ref}>
        {feed.length === 0 && <li className="muted">{t('Starting the session…')}</li>}
        {feed.map((f, i) => (
          <li key={i} className={i === feed.length - 1 ? 'cur' : ''}>{f}</li>
        ))}
      </ul>
      <div className="todo-list">
        <span>✓ {t('Survey the project')}</span>
        <span>✓ {t('Write BRIEF.md for the whole office')}</span>
        <span>✓ {t('Propose staff & skills')}</span>
      </div>
    </section>
  );
}

// ---------- 4. proposal ----------

const ROLE_ICON: Record<string, string> = {
  dev: '💻', frontend: '🎨', backend: '🗄️', uiux: '✏️', tester: '🧪', reviewer: '🔍', devops: '🚀', docs: '📚',
  scriptwriter: '📝', storyboard: '🎞️', motion: '✨', editor: '🎬', audio: '🎧', qa: '🔍',
  researcher: '🔎', writer: '✍️', analyst: '📊', builder: '🛠️', designer: '🎨',
};

function ProposalStep({ snap }: { snap: AppSnapshot }) {
  const p = snap.office!.proposal!;
  const [feedback, setFeedback] = useState('');
  const { err, busy, wrap } = useErr();
  return (
    <section>
      <StepHead kicker={t('STEP {n}', { n: 4 })} title={t('Proposed team: {n} people', { n: p.team.length })} />
      <div className="summary-card">
        <span className="field-label">{t('Project summary')}</span>
        <p>{p.summary}</p>
      </div>
      <div className="team">
        {p.team.map((r, i) => (
          <div key={i} className="role-card">
            <span className="role-icon">{ROLE_ICON[r.roleKey] ?? '🧑‍💻'}</span>
            <div className="grow">
              <div className="row">
                <b className="grow">{r.title}</b>
                <span className={`tier ${r.modelTier}`}>{tierLabel(r.modelTier)}</span>
              </div>
              <small className="muted">{r.why}</small>
              {r.skills.length > 0 && (
                <div className="chips small">
                  {r.skills.map((s) => (
                    <span key={s} className="chip">🧰 {s}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {p.risks.length > 0 && (
        <details className="risks" open>
          <summary>⚠ {t('{n} note(s) & limits', { n: p.risks.length })}</summary>
          <ul>
            {p.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <label className="field">
        {t('Want changes?')}
        <div className="row">
          <input className="grow" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder={t('e.g. “add a tester”, “only two people”')} />
          <button className="px-btn" disabled={!feedback.trim() || busy} onClick={wrap(() => api('office/analyze', { feedback }))}>{t('Send')}</button>
        </div>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={busy} onClick={wrap(() => api('office/accept', {}))}>{t('Accept & assign')} →</button>
      </div>
    </section>
  );
}

// ---------- 5. staffing ----------

export function Staffing({ snap }: { snap: AppSnapshot }) {
  const [specs, setSpecs] = useState<HireSpec[]>([]);
  const { err, busy, wrap } = useErr();
  const o = snap.office!;
  const existing = o.employees.length;
  const room = 6 - existing;
  useEffect(() => {
    api<HireSpec[]>('office/staffing').then((s) => setSpecs(s.slice(0, room)));
  }, []);
  const set = (i: number, patch: Partial<HireSpec>) => setSpecs((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const addBlank = () => {
    const acc = [...snap.accounts].filter((a) => a.loggedIn).sort((a, b) => (a.usage?.weekly?.usedPercent ?? 0) - (b.usage?.weekly?.usedPercent ?? 0))[0];
    if (!acc) return;
    const model = snap.models[acc.provider].find((m) => m.tier === 'standard') ?? snap.models[acc.provider][0];
    const role = o.template === 'video' ? ['editor', 'Video Editor'] : o.template === 'other' ? ['writer', 'Writer'] : ['dev', 'Developer'];
    setSpecs((s) => [...s, { roleKey: role[0], title: role[1], provider: acc.provider, accountId: acc.id, model: model.id, effort: 'medium', skills: [] }]);
  };

  return (
    <section>
      <StepHead
        kicker={existing ? t('HIRE MORE') : t('STEP {n}', { n: 5 })}
        title={t('Accounts & models')}
        sub={t('Several people can share one account (they share its quota). Hard work → strong model, small chores → fast model.')}
      />
      {specs.map((s, i) => (
        <SpecEditor key={i} spec={s} snap={snap} onChange={(p) => set(i, p)} onRemove={() => setSpecs((x) => x.filter((_, k) => k !== i))} />
      ))}
      <button className="add-slot" disabled={specs.length >= room} onClick={addBlank}>
        ＋ {t('Add an employee')} <small>({existing + specs.length}/6)</small>
      </button>
      {err && <p className="error">{err}</p>}
      <div className="actions">
        {existing > 0 && <button className="px-btn" onClick={() => api('office/hire', { specs: [] })}>{t('Cancel')}</button>}
        <button className="px-btn primary big" disabled={!specs.length || busy} onClick={wrap(() => api('office/hire', { specs }))}>
          {t('Bring {n} people into the office', { n: specs.length })} →
        </button>
      </div>
    </section>
  );
}

function SpecEditor({ spec, snap, onChange, onRemove }: { spec: HireSpec; snap: AppSnapshot; onChange: (p: Partial<HireSpec>) => void; onRemove: () => void }) {
  const acc = snap.accounts.find((a) => a.id === spec.accountId);
  const models = snap.models[spec.provider];
  const efforts = models.find((m) => m.id === spec.model)?.efforts ?? ['low', 'medium', 'high'];
  const o = snap.office!;
  const sharing = o.employees.filter((e) => e.accountId === spec.accountId).length + (o.coordinator?.accountId === spec.accountId ? 1 : 0);
  return (
    <div className="spec" style={{ ['--badge' as any]: acc?.color }}>
      <div className="row">
        <input className="grow title-input" value={spec.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={t('Job title')} />
        <button className="icon-btn" onClick={onRemove} aria-label={t('Remove')}>✕</button>
      </div>
      <div className="acc-chooser">
        {snap.accounts.filter((a) => a.loggedIn).map((a) => (
          <button
            key={a.id}
            className={`acc-chip ${a.id === spec.accountId ? 'on' : ''}`}
            style={{ ['--badge' as any]: a.color }}
            onClick={() => {
              const keepModel = a.provider === spec.provider;
              const tier = models.find((m) => m.id === spec.model)?.tier ?? 'standard';
              const nm = snap.models[a.provider].find((m) => m.tier === tier) ?? snap.models[a.provider][0];
              onChange({ accountId: a.id, provider: a.provider, model: keepModel ? spec.model : nm.id });
            }}
          >
            <ProviderIcon provider={a.provider} size={16} />
            {a.label}
            <span className="acc-chip-hp" title={t('5-hour quota left')}>{100 - (a.usage?.fiveHour?.usedPercent ?? 0)}%</span>
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field">
          {t('Model')}
          <select value={spec.model} onChange={(e) => onChange({ model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label.replace(/\s*\(.*\)$/, '')} — {tierLabel(m.tier)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('Reasoning effort')}
          <select value={spec.effort} onChange={(e) => onChange({ effort: e.target.value })}>
            {efforts.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      {sharing > 0 && <small className="muted">{t('Shares this account with {n} other(s).', { n: sharing })}</small>}
      <SkillPicker all={snap.skills} provider={spec.provider} value={spec.skills} onChange={(skills) => onChange({ skills })} />
    </div>
  );
}

export function SkillPicker({ all, provider, value, onChange }: { all: SkillInfo[]; provider: Provider; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const avail = useMemo(() => all.filter((s) => s.provider === 'both' || s.provider === provider), [all, provider]);
  const results = q ? avail.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(q.toLowerCase())).slice(0, 6) : [];
  return (
    <div className="skills">
      <div className="chips small">
        {value.map((s) => (
          <span key={s} className="chip">
            🧰 {s}
            <button onClick={() => onChange(value.filter((x) => x !== s))} aria-label={t('Remove skill {name}', { name: s })}>✕</button>
          </span>
        ))}
        <input className="skill-q" placeholder={t('＋ add a skill ({n})', { n: avail.length })} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {results.length > 0 && (
        <div className="skill-results">
          {results.map((s) => (
            <button
              key={s.name}
              onClick={() => {
                if (!value.includes(s.name)) onChange([...value, s.name]);
                setQ('');
              }}
            >
              <b>{s.name}</b>
              <small>{s.description.slice(0, 90)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
