import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { Modal } from './ui';

interface Listing {
  path: string;
  parent?: string;
  dirs: { name: string; git: boolean }[];
  roots: { label: string; path: string }[];
}

/** In-app folder browser: works everywhere, even when no native dialog can be shown. */
export function FolderBrowser({ start, onPick, onClose }: { start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [list, setList] = useState<Listing>();
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');

  const go = async (p?: string) => {
    setErr('');
    try {
      const l = await api<Listing>(`fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      setList(l);
      setTyped(l.path);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    void go(start);
  }, []);

  const sep = list?.path.includes('\\') ? '\\' : '/';
  const crumbs = list ? list.path.split(/[\\/]/).filter(Boolean) : [];

  return (
    <Modal title={t('Choose a project folder')} icon="📁" onClose={onClose} wide>
      <div className="fb">
        <div className="fb-roots">
          {list?.roots.map((r) => (
            <button key={r.path} className={list.path === r.path ? 'on' : ''} onClick={() => go(r.path)}>
              {r.label === '~' ? '🏠' : r.label.endsWith(':') ? '💽' : '📂'} {r.label === '~' ? t('Home') : r.label}
            </button>
          ))}
        </div>
        <form
          className="fb-path"
          onSubmit={(e) => {
            e.preventDefault();
            void go(typed);
          }}
        >
          <button type="button" className="px-btn small" disabled={!list?.parent} onClick={() => go(list?.parent)} aria-label={t('Up one level')}>
            ↑
          </button>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
          <button className="px-btn small" type="submit">{t('Go')}</button>
        </form>
        <div className="fb-crumbs">
          {crumbs.map((c, i) => {
            const p = (list!.path.startsWith('/') ? '/' : '') + crumbs.slice(0, i + 1).join(sep) + (i === 0 && /:$/.test(c) ? sep : '');
            return (
              <button key={i} onClick={() => go(p)}>
                {c}
              </button>
            );
          })}
        </div>
        {err && <p className="error">{err}</p>}
        <div className="fb-list">
          {!list && <p className="muted">{t('Loading…')}</p>}
          {list && list.dirs.length === 0 && <p className="muted fb-empty">{t('No sub-folders here.')}</p>}
          {list?.dirs.map((d) => (
            <button key={d.name} className="fb-item" onDoubleClick={() => onPick(list.path + (list.path.endsWith(sep) ? '' : sep) + d.name)} onClick={() => go(list.path + (list.path.endsWith(sep) ? '' : sep) + d.name)}>
              <span className="folder-icon small" aria-hidden />
              <span className="grow ellipsis">{d.name}</span>
              {d.git && <span className="pill green">git</span>}
            </button>
          ))}
        </div>
        <div className="actions">
          <span className="muted small grow ellipsis" title={list?.path}>
            {list?.path}
          </span>
          <button className="px-btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="px-btn primary" disabled={!list} onClick={() => list && onPick(list.path)}>
            {t('Use this folder')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
