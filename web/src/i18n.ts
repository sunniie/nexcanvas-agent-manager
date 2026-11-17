// UI translations. Keys are the English strings; vi / zh dictionaries live in ./locales.
import type { Lang } from '../../shared/types';
import { VI } from './locales/vi';
import { ZH } from './locales/zh';

let current: Lang = 'en';
const DICTS: Record<Lang, Record<string, string>> = { en: {}, vi: VI, zh: ZH };

export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
}

export function getLang(): Lang {
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export const LOCALE: Record<Lang, string> = { en: 'en-US', vi: 'vi-VN', zh: 'zh-CN' };
export const locale = () => LOCALE[current];

export const LANG_META: Record<Lang, { native: string; english: string; flag: string; hello: string }> = {
  en: { native: 'English', english: 'English', flag: 'EN', hello: 'Welcome to the office' },
  vi: { native: 'Tiếng Việt', english: 'Vietnamese', flag: 'VI', hello: 'Chào mừng đến văn phòng' },
  zh: { native: '中文', english: 'Chinese', flag: '中', hello: '欢迎来到办公室' },
};
