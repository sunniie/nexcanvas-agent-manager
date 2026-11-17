import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSnapshot, PastSession, Provider, SkillInfo } from '../../../shared/types';
import { api, fmtTime, onBubble } from '../api';
import { MODEL_TIER_LABEL, Pill, ProviderIcon, StatBar } from './ui';

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
  ['choose-coordinator', 'Trưởng phòng'],
  ['choose-folder', 'Dự án'],
  ['context', 'Tài liệu'],
  ['proposal', 'Nhân sự'],
  ['staffing', 'Phân công'],
];

export function Setup({ snap }: { snap: AppSnapshot }) {
  const phase = snap.office.phase;
  const idx = phase === 'analyzing' ? 2.5 : STEPS.findIndex(([k]) => k === phase);
  const rehiring = phase === 'staffing' && snap.office.employees.length > 0;
  return (
    <div className="setup">
      {!rehiring && (
        <ol className="steps" aria-label="Các bước thiết lập">
          {STEPS.map(([k, label], i) => (
            <li key={k} className={i < idx ? 'done' : Math.ceil(idx) === i ? 'cur' : ''}>
              <span className="node">{i < idx ? '✓' : i + 1}</span>
              <span className="lbl">{label}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="setup-body">
        {phase === 'choose-coordinator' && <ChooseCoordinator snap={snap} />}
        {phase === 'choose-folder' && <ChooseFolder />}
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

// ---------- 1. coordinator ----------

function ChooseCoordinator({ snap }: { snap: AppSnapshot }) {
  const [provider, setProvider] = useState<Provider>();
  const [accountId, setAccountId] = useState('');
  const [model, setModel] = useState('');
  const { err, busy, wrap } = useErr();
  const accs = snap.accounts.filter((a) => a.provider === provider);

  useEffect(() => {
    if (!provider) return;
    const first = snap.accounts.find((a) => a.provider === provider && a.loggedIn);
    setAccountId(first?.id ?? '');
    setModel(snap.models[provider].find((m) => m.tier === 'high')?.id ?? snap.models[provider][0]?.id ?? '');
  }, [provider]);

  return (
    <section>
      <StepHead kicker="BƯỚC 1" title="Chọn Trưởng phòng" sub="Agent điều phối: đọc dự án, đề xuất nhân sự, chia việc, review và báo cáo lại cho bạn." />
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
              <small>{ok ? `${main?.displayName ?? main?.email ?? ''}` : 'Chưa đăng nhập'}</small>
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
              Tài khoản
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accs.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.loggedIn}>
                    {a.label} {a.email ? `· ${a.email}` : ''} {a.loggedIn ? '' : '(chưa đăng nhập)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field">
            Model cho Trưởng phòng
            <div className="model-list">
              {snap.models[provider].slice(0, 5).map((m) => (
                <button key={m.id} className={`model-opt ${model === m.id ? 'on' : ''}`} onClick={() => setModel(m.id)}>
                  <b>{m.label.replace(/\s*\(.*\)$/, '')}</b>
                  <span className={`tier ${m.tier}`}>{MODEL_TIER_LABEL[m.tier]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={!provider || !accountId || busy} onClick={wrap(() => api('office/coordinator', { provider, accountId, model }))}>
          Bổ nhiệm Trưởng phòng →
        </button>
      </div>
    </section>
  );
}

// ---------- 2. folder ----------

function ChooseFolder() {
  const [path, setPath] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const { err, busy, wrap } = useErr();
  useEffect(() => {
    api<string[]>('recent').then(setRecent).catch(() => {});
  }, []);
  const pick = wrap(async () => {
    const r = await api<{ path?: string }>('fs/pick', {});
    if (r.path) setPath(r.path);
  });
  return (
    <section>
      <StepHead kicker="BƯỚC 2" title="Làm việc trên dự án nào?" sub="Văn phòng sẽ tạo thư mục .office/ trong dự án (tự loại khỏi git)." />
      <button className="drop-card" onClick={pick} disabled={busy}>
        <span className="folder-icon" aria-hidden />
        <b>{path ? path.split(/[\\/]/).pop() : 'Chọn thư mục dự án…'}</b>
        <small>{path || 'Mở hộp thoại chọn thư mục của hệ điều hành'}</small>
      </button>
      <label className="field">
        hoặc dán đường dẫn
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\...\my-project" />
      </label>
      {recent.length > 0 && (
        <div className="recent">
          <span className="field-label">Gần đây</span>
          {recent.map((r) => (
            <button key={r} className={`recent-item ${r === path ? 'on' : ''}`} onClick={() => setPath(r)}>
              <span className="folder-icon small" aria-hidden />
              <span className="ellipsis">
                <b>{r.split(/[\\/]/).pop()}</b>
                <small>{r}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={!path.trim() || busy} onClick={wrap(() => api('office/folder', { path: path.trim() }))}>
          Vào văn phòng →
        </button>
      </div>
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
  const files = snap.office.contextFiles;

  return (
    <section>
      <StepHead kicker="BƯỚC 3" title="Tài liệu đi kèm" sub="Giúp Trưởng phòng hiểu những gì bạn đã trao đổi trước đây. Không bắt buộc." />

      <div className={`acc-item ${open === 'auto' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'auto' ? '' : 'auto')}>
          <span>⚡</span>
          <b>Phiên chat cũ trên máy</b>
          <Pill tone="green">{sessions ? `${sessions.length} phiên` : '…'}</Pill>
        </button>
        {open === 'auto' && (
          <div className="acc-item-body">
            {!sessions ? (
              <p className="muted">Đang tìm…</p>
            ) : sessions.length === 0 ? (
              <p className="muted">Không có phiên Claude/Codex nào cho thư mục này.</p>
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
                          e.target.checked ? n.add(s.id) : n.delete(s.id);
                          setPicked(n);
                        }}
                      />
                      <ProviderIcon provider={s.provider} size={16} />
                      <span className="grow ellipsis" title={s.title}>{s.title}</span>
                      <small className="muted">{new Date(s.updatedAt).toLocaleDateString('vi-VN')}</small>
                    </label>
                  ))}
                </div>
                <button className="px-btn small" disabled={!picked.size || busy} onClick={wrap(async () => {
                  await api('context/import', { ids: [...picked] });
                  setPicked(new Set());
                })}>
                  Nhập {picked.size || ''} phiên
                </button>
                <small className="muted hint">Lọc gọn bằng code (bỏ tool call), không tốn token.</small>
              </>
            )}
          </div>
        )}
      </div>

      <div className={`acc-item ${open === 'file' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'file' ? '' : 'file')}>
          <span>📄</span>
          <b>Tải lên file .txt / .md</b>
        </button>
        {open === 'file' && (
          <div className="acc-item-body">
            <label className="upload-zone">
              <input type="file" accept=".txt,.md,text/plain" multiple hidden onChange={(e) => upload(e.target.files)} />
              <b>⬆ Chọn file</b>
              <small>Ghi chú, yêu cầu, tài liệu bàn giao…</small>
            </label>
          </div>
        )}
      </div>

      <div className={`acc-item ${open === 'prompt' ? 'open' : ''}`}>
        <button className="acc-item-head" onClick={() => setOpen(open === 'prompt' ? '' : 'prompt')}>
          <span>📋</span>
          <b>Xuất từ chat cũ (thủ công)</b>
        </button>
        {open === 'prompt' && (
          <div className="acc-item-body">
            <ol className="manual">
              <li>Copy prompt bàn giao bên dưới</li>
              <li>Dán vào phiên chat cũ (Claude, ChatGPT…)</li>
              <li>Lưu câu trả lời thành .txt rồi tải lên ở mục trên</li>
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
              {copied ? '✓ Đã copy' : 'Copy prompt'}
            </button>
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="file-list">
          <span className="field-label">Đã đính kèm ({files.length})</span>
          {files.map((f) => (
            <span key={f} className="file-chip">
              📄 <span className="ellipsis">{f}</span>
              <button onClick={() => api('context/remove', { name: f })} aria-label={`Bỏ ${f}`}>✕</button>
            </span>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={busy} onClick={wrap(() => api('office/analyze', {}))}>
          {files.length ? 'Phân tích dự án →' : 'Bỏ qua, phân tích luôn →'}
        </button>
      </div>
    </section>
  );
}

function Analyzing({ snap }: { snap: AppSnapshot }) {
  const [feed, setFeed] = useState<string[]>([]);
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const off = onBubble((id, text) => id === 'lead' && setFeed((f) => [...f.slice(-7), text]));
    return () => void off();
  }, []);
  useEffect(() => {
    // braces matter: newer Chromium returns a Promise from scrollTo, and React would call it as a cleanup
    ref.current?.scrollTo({ top: 9999 });
  }, [feed]);
  const job = snap.office.jobs.find((j) => j.employeeId === 'lead' && ['running', 'queued', 'waiting_quota'].includes(j.status));
  return (
    <section className="analyzing">
      <div className="reading-anim" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <h2>Trưởng phòng đang đọc dự án…</h2>
      {job?.status === 'waiting_quota' && <p className="warn">😴 Hết hạn mức — tự chạy lại lúc {fmtTime(job.resumeAt!)}</p>}
      <ul className="feed" ref={ref}>
        {feed.length === 0 && <li className="muted">Khởi động phiên làm việc…</li>}
        {feed.map((f, i) => (
          <li key={i} className={i === feed.length - 1 ? 'cur' : ''}>{f}</li>
        ))}
      </ul>
      <div className="todo-list">
        <span>✓ Khảo sát cấu trúc repo</span>
        <span>✓ Viết BRIEF.md cho cả văn phòng</span>
        <span>✓ Đề xuất nhân sự &amp; skill</span>
      </div>
    </section>
  );
}

// ---------- 4. proposal ----------

const ROLE_ICON: Record<string, string> = { dev: '💻', frontend: '🎨', backend: '🗄️', uiux: '✏️', tester: '🧪', reviewer: '🔍', devops: '🚀', docs: '📚' };

function ProposalStep({ snap }: { snap: AppSnapshot }) {
  const p = snap.office.proposal!;
  const [feedback, setFeedback] = useState('');
  const { err, busy, wrap } = useErr();
  return (
    <section>
      <StepHead kicker="BƯỚC 4" title={`Đề xuất ${p.team.length} nhân viên`} />
      <div className="summary-card">
        <span className="field-label">Tóm tắt dự án</span>
        <p>{p.summary}</p>
      </div>
      <div className="team">
        {p.team.map((r, i) => (
          <div key={i} className="role-card">
            <span className="role-icon">{ROLE_ICON[r.roleKey] ?? '🧑‍💻'}</span>
            <div className="grow">
              <div className="row">
                <b className="grow">{r.title}</b>
                <span className={`tier ${r.modelTier}`}>{MODEL_TIER_LABEL[r.modelTier]}</span>
              </div>
              <small className="muted">{r.why}</small>
              {r.skills.length > 0 && (
                <div className="chips small">
                  {r.skills.map((s) => <span key={s} className="chip">🧰 {s}</span>)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {p.risks.length > 0 && (
        <details className="risks">
          <summary>⚠ {p.risks.length} lưu ý / rủi ro</summary>
          <ul>{p.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </details>
      )}
      <label className="field">
        Muốn điều chỉnh?
        <div className="row">
          <input className="grow" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder='vd: "thêm 1 tester", "chỉ cần 2 người"' />
          <button className="px-btn" disabled={!feedback.trim() || busy} onClick={wrap(() => api('office/analyze', { feedback }))}>Gửi</button>
        </div>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="px-btn primary big" disabled={busy} onClick={wrap(() => api('office/accept', {}))}>Đồng ý, phân công →</button>
      </div>
    </section>
  );
}

// ---------- 5. staffing ----------

export function Staffing({ snap }: { snap: AppSnapshot }) {
  const [specs, setSpecs] = useState<HireSpec[]>([]);
  const { err, busy, wrap } = useErr();
  const existing = snap.office.employees.length;
  const room = 6 - existing;
  useEffect(() => {
    api<HireSpec[]>('office/staffing').then((s) => setSpecs(s.slice(0, room)));
  }, []);
  const set = (i: number, patch: Partial<HireSpec>) => setSpecs((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const addBlank = () => {
    const acc = [...snap.accounts].filter((a) => a.loggedIn).sort((a, b) => (a.usage?.weekly?.usedPercent ?? 0) - (b.usage?.weekly?.usedPercent ?? 0))[0];
    if (!acc) return;
    const model = snap.models[acc.provider].find((m) => m.tier === 'standard') ?? snap.models[acc.provider][0];
    setSpecs((s) => [...s, { roleKey: 'dev', title: 'Developer', provider: acc.provider, accountId: acc.id, model: model.id, effort: 'medium', skills: [] }]);
  };

  return (
    <section>
      <StepHead
        kicker={existing ? 'TUYỂN THÊM' : 'BƯỚC 5'}
        title="Phân công tài khoản & model"
        sub="Nhiều người có thể dùng chung 1 tài khoản (chung hạn mức). Việc khó → model mạnh, việc lặt vặt → model nhanh."
      />
      {specs.map((s, i) => (
        <SpecEditor key={i} spec={s} snap={snap} onChange={(p) => set(i, p)} onRemove={() => setSpecs((x) => x.filter((_, k) => k !== i))} />
      ))}
      <button className="add-slot" disabled={specs.length >= room} onClick={addBlank}>
        ＋ Thêm nhân viên <small>({existing + specs.length}/6)</small>
      </button>
      {err && <p className="error">{err}</p>}
      <div className="actions">
        {existing > 0 && <button className="px-btn" onClick={() => api('office/hire', { specs: [] })}>Hủy</button>}
        <button className="px-btn primary big" disabled={!specs.length || busy} onClick={wrap(() => api('office/hire', { specs }))}>
          Cho {specs.length} người vào văn phòng →
        </button>
      </div>
    </section>
  );
}

function SpecEditor({ spec, snap, onChange, onRemove }: { spec: HireSpec; snap: AppSnapshot; onChange: (p: Partial<HireSpec>) => void; onRemove: () => void }) {
  const acc = snap.accounts.find((a) => a.id === spec.accountId);
  const models = snap.models[spec.provider];
  const efforts = models.find((m) => m.id === spec.model)?.efforts ?? ['low', 'medium', 'high'];
  const sharing = snap.office.employees.filter((e) => e.accountId === spec.accountId).length + (snap.office.coordinator?.accountId === spec.accountId ? 1 : 0);
  return (
    <div className="spec" style={{ ['--badge' as any]: acc?.color }}>
      <div className="row">
        <input className="grow title-input" value={spec.title} onChange={(e) => onChange({ title: e.target.value })} aria-label="Chức danh" />
        <button className="icon-btn" onClick={onRemove} aria-label="Bỏ người này">✕</button>
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
            <span className="acc-chip-hp" title="Hạn mức 5h còn lại">{100 - (a.usage?.fiveHour?.usedPercent ?? 0)}%</span>
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field">
          Model
          <select value={spec.model} onChange={(e) => onChange({ model: e.target.value })}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label} — {MODEL_TIER_LABEL[m.tier]}</option>)}
          </select>
        </label>
        <label className="field">
          Độ suy nghĩ
          <select value={spec.effort} onChange={(e) => onChange({ effort: e.target.value })}>
            {efforts.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      </div>
      {sharing > 0 && <small className="muted">Dùng chung tài khoản với {sharing} người khác.</small>}
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
            <button onClick={() => onChange(value.filter((x) => x !== s))} aria-label={`Bỏ skill ${s}`}>✕</button>
          </span>
        ))}
        <input className="skill-q" placeholder={`＋ thêm skill (${avail.length})`} value={q} onChange={(e) => setQ(e.target.value)} />
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
