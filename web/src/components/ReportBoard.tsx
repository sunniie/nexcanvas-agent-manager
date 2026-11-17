import { useMemo, useRef, useState } from 'react';
import { MAX_EVIDENCE, type AppSnapshot, type Employee, type Evidence, type Task } from '../../../shared/types';
import { api, fmtTime } from '../api';
import { locale, t } from '../i18n';
import { attachmentURL, imageFiles, toUpload } from '../images';
import { Avatar, Modal, Rich } from './ui';

const evidenceURL = (officeId: string, ev: Evidence) => attachmentURL(officeId, ev.file, 'evidence');
const doneAt = (x: Task) => x.doneAt ?? x.updatedAt;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const resultOf = (x: Task) => x.report?.result?.trim() || x.report?.summary?.trim() || '';

/** Pinboard of finished tasks: proof screenshots + a one-line result each. */
export function ReportBoard({ snap }: { snap: AppSnapshot }) {
  const o = snap.office!;
  const [open, setOpen] = useState<string>();
  const staff = useMemo(() => new Map(([o.coordinator, ...o.employees].filter(Boolean) as Employee[]).map((e) => [e.id, e])), [o]);

  // Group finished tasks by the request they came from, newest request first.
  const groups = useMemo(() => {
    const done = o.tasks.filter((x) => x.status === 'done').sort((a, b) => doneAt(b) - doneAt(a));
    const map = new Map<string, Task[]>();
    for (const x of done) {
      const k = x.goal ?? '';
      map.set(k, [...(map.get(k) ?? []), x]);
    }
    return [...map.entries()];
  }, [o.tasks]);
  const total = groups.reduce((n, [, xs]) => n + xs.length, 0);
  const shots = groups.reduce((n, [, xs]) => n + xs.reduce((m, x) => m + (x.evidence?.length ?? 0), 0), 0);
  const task = open ? o.tasks.find((x) => x.id === open) : undefined;

  return (
    <div className="board">
      <div className="board-head">
        <div>
          <h3>📌 {t('Report board')}</h3>
          <small>{t('{n} finished tasks · {m} evidence images', { n: total, m: shots })}</small>
        </div>
        {total > 0 && (
          <button className="px-btn small" onClick={() => void exportBoard(snap, groups, staff)}>
            ⬇ {t('Export (HTML)')}
          </button>
        )}
      </div>
      {total === 0 && (
        <div className="board-empty">
          <span>📌</span>
          <b>{t('Nothing pinned yet')}</b>
          <p>{t('Every finished task is pinned here with its evidence screenshots and a short result.')}</p>
        </div>
      )}
      {groups.map(([goal, xs]) => (
        <section key={goal} className="board-group">
          <h4>
            <span>{t('Request')}</span> <q title={goal}>{goal || t('(earlier work)')}</q>
          </h4>
          <div className="board-grid">
            {xs.map((x) => (
              <ReportCard key={x.id} officeId={o.id} task={x} who={staff.get(x.assigneeId)} onOpen={() => setOpen(x.id)} />
            ))}
          </div>
        </section>
      ))}
      {task && <ReportDetail officeId={o.id} task={task} who={staff.get(task.assigneeId)} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function ReportCard({ officeId, task: x, who, onOpen }: { officeId: string; task: Task; who?: Employee; onOpen: () => void }) {
  const ev = x.evidence ?? [];
  return (
    <article className="rcard" onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <i className="rpin" aria-hidden />
      <div className="rcard-shot">
        {ev[0] ? (
          <>
            <img src={evidenceURL(officeId, ev[0])} alt={ev[0].caption || t('Evidence')} loading="lazy" />
            {ev.length > 1 && <span className="rcard-more">+{ev.length - 1}</span>}
          </>
        ) : (
          <span className="rcard-noshot">{t('No screenshot')}</span>
        )}
      </div>
      <div className="rcard-body">
        <div className="rcard-meta">
          <span className="rcard-id">{x.id}</span>
          <span className="rcard-ok">✓ {t('Done')}</span>
          <time>{fmtTime(doneAt(x))}</time>
        </div>
        <b className="rcard-title">{x.title}</b>
        <p className="rcard-result">{resultOf(x)}</p>
        <div className="rcard-foot">
          {who && <Avatar e={who} size={18} />}
          <span>{who?.name ?? x.assigneeId}</span>
          {x.report?.tests && <span className="rcard-chip" title={x.report.tests}>🧪</span>}
          {x.merge?.status === 'merged' && <span className="rcard-chip" title={x.merge.commit}>⎇ {x.merge.commit?.slice(0, 7)}</span>}
        </div>
      </div>
    </article>
  );
}

function ReportDetail({ officeId, task: x, who, onClose }: { officeId: string; task: Task; who?: Employee; onClose: () => void }) {
  const [caption, setCaption] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ev = x.evidence ?? [];

  const add = async (files: File[]) => {
    if (!files.length) return;
    setErr('');
    setBusy(true);
    try {
      for (const f of files.slice(0, MAX_EVIDENCE - ev.length)) {
        const { name, data } = await toUpload(f);
        await api('task/evidence/add', { id: x.id, image: { name, data }, caption });
      }
      setCaption('');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${x.id} · ${x.title}`} icon="📌" wide onClose={onClose}>
      <div
        className="rdetail"
        onPaste={(e) => {
          const files = imageFiles(e.clipboardData);
          if (files.length) {
            e.preventDefault();
            void add(files);
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void add(imageFiles(e.dataTransfer));
        }}
      >
        <div className="rdetail-who">
          {who && <Avatar e={who} size={26} />}
          <span>
            <b>{who?.name ?? x.assigneeId}</b> · {who?.title}
          </span>
          <time>
            ✓ {fmtDay(doneAt(x))} {fmtTime(doneAt(x))}
          </time>
        </div>
        {resultOf(x) && (
          <div className="rdetail-result">
            <Rich text={resultOf(x)} />
          </div>
        )}

        <h5>{t('Evidence')}</h5>
        <div className="rdetail-shots">
          {ev.map((e) => (
            <figure key={e.file}>
              <a href={evidenceURL(officeId, e)} target="_blank" rel="noreferrer">
                <img src={evidenceURL(officeId, e)} alt={e.caption || t('Evidence')} />
              </a>
              <figcaption>
                <span className={`by ${e.by}`}>{e.by === 'boss' ? t('You') : who?.name ?? t('Employee')}</span>
                {e.caption || <i className="muted">{t('(no caption)')}</i>}
              </figcaption>
              <button className="rdetail-del" title={t('Remove image')} aria-label={t('Remove image')} onClick={() => void api('task/evidence/remove', { id: x.id, file: e.file })}>
                ×
              </button>
            </figure>
          ))}
          {ev.length < MAX_EVIDENCE && (
            <div className="rdetail-add">
              <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t('Caption (optional)')} maxLength={240} />
              <button className="px-btn small primary" disabled={busy} onClick={() => input.current?.click()}>
                ＋ {t('Add screenshot')}
              </button>
              <small className="muted">{t('or paste (Ctrl+V) / drop an image here')}</small>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  void add([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </div>
        {err && <p className="error">{err}</p>}

        {x.report?.summary && x.report.summary !== resultOf(x) && (
          <>
            <h5>{t('Employee report')}</h5>
            <div className="rdetail-text">
              <Rich text={x.report.summary} />
            </div>
          </>
        )}
        {x.report?.tests && (
          <>
            <h5>🧪 {t('Tests')}</h5>
            <pre className="rdetail-pre">{x.report.tests}</pre>
          </>
        )}
        {!!x.report?.files_changed?.length && (
          <>
            <h5>{t('Files changed')}</h5>
            <ul className="rdetail-files">
              {x.report.files_changed.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        {x.reviewNote && (
          <>
            <h5>👍 {t("Lead's review")}</h5>
            <div className="rdetail-text">{x.reviewNote}</div>
          </>
        )}
        {x.merge?.status === 'merged' && (
          <p className="muted">
            ⎇ {t('Merged into the main branch')} · <code>{x.merge.commit}</code>
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---------- export ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function toDataURL(url: string) {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

/** A single self-contained HTML file (images embedded) that can be sent to anyone. */
async function exportBoard(snap: AppSnapshot, groups: [string, Task[]][], staff: Map<string, Employee>) {
  const o = snap.office!;
  const sections: string[] = [];
  for (const [goal, xs] of groups) {
    const cards: string[] = [];
    for (const x of xs) {
      const imgs: string[] = [];
      for (const e of x.evidence ?? []) {
        const src = await toDataURL(evidenceURL(o.id, e)).catch(() => '');
        if (src) imgs.push(`<figure><img src="${src}" alt=""><figcaption>${esc(e.caption)}</figcaption></figure>`);
      }
      cards.push(`<article>
  <div class="meta"><b>${esc(x.id)}</b> · ${esc(staff.get(x.assigneeId)?.name ?? '')} · ${esc(fmtDay(doneAt(x)))}</div>
  <h3>${esc(x.title)}</h3>
  <p>${esc(resultOf(x))}</p>
  ${imgs.join('\n')}
  ${x.report?.tests ? `<pre>${esc(x.report.tests)}</pre>` : ''}
</article>`);
    }
    sections.push(`<section><h2>${esc(goal || t('(earlier work)'))}</h2>${cards.join('\n')}</section>`);
  }
  const title = `${o.name} — ${t('Report board')}`;
  const html = `<!doctype html><html lang="${snap.language ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:15px/1.55 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f4f1ea;color:#1d1d1f}
main{max-width:980px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 12px;padding-top:12px;border-top:2px solid #d8d2c4}
article{background:#fff;border:1px solid #e2ddd2;border-radius:8px;padding:16px;margin:0 0 14px}h3{margin:4px 0 6px;font-size:16px}
.meta{font-size:12px;color:#6b6b6b}figure{margin:10px 0}img{max-width:100%;border:1px solid #ddd;border-radius:4px}figcaption{font-size:13px;color:#555}
pre{background:#f6f6f4;padding:8px 10px;border-radius:4px;white-space:pre-wrap;font-size:12px}
</style></head><body><main><h1>${esc(title)}</h1><div class="meta">${esc(new Date().toLocaleString(locale()))}</div>
${sections.join('\n')}</main></body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = `${o.name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}-report.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
