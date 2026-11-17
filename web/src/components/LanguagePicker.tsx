import { useState } from 'react';
import { LANGS, type Lang } from '../../../shared/types';
import { api } from '../api';
import { LANG_META } from '../i18n';

/** First-launch screen: pick the interface language (also the default language for new offices). */
export function LanguagePicker() {
  const [busy, setBusy] = useState<Lang>();
  return (
    <div className="lang-screen">
      <div className="lang-hero">
        <span className="logo-big">▣</span>
        <b className="lang-brand">NEXCANVAS</b>
        <span className="lang-sub">Agent Manager</span>
      </div>
      <p className="lang-prompt">
        Choose your language · Chọn ngôn ngữ · 选择语言
      </p>
      <div className="lang-grid">
        {LANGS.map((l) => (
          <button
            key={l}
            className="lang-card"
            disabled={!!busy}
            onClick={async () => {
              setBusy(l);
              await api('lang', { language: l });
            }}
          >
            <span className="lang-flag">{LANG_META[l].flag}</span>
            <b>{LANG_META[l].native}</b>
            <small>{LANG_META[l].hello}</small>
            {busy === l && <span className="loader small" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Compact language switcher for the top bar. */
export function LanguageSwitch({ current }: { current: Lang }) {
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l} className={l === current ? 'on' : ''} onClick={() => l !== current && api('lang', { language: l })} title={LANG_META[l].native}>
          {LANG_META[l].flag}
        </button>
      ))}
    </div>
  );
}
