import { createStore, safeStorage, useStore } from '../lib/store';
import { en } from './en';
import { pl } from './pl';

export type Key = keyof typeof en;
export type Lang = 'en' | 'pl';
export const LANGS: readonly Lang[] = ['en', 'pl'];

const dictionaries: Record<Lang, Record<Key, string>> = { en, pl };
const storage = safeStorage('local');
const KEY = 'mindgate.lang';

function detect(): Lang {
  const saved = storage.getItem(KEY);
  if (saved === 'en' || saved === 'pl') return saved;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

const store = createStore<Lang>(detect());

export const getLang = (): Lang => store.get();
export function setLang(lang: Lang): void {
  storage.setItem(KEY, lang);
  store.set(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export type Params = Record<string, string | number>;

export function translate(lang: Lang, key: Key, params?: Params): string {
  const text = dictionaries[lang][key] ?? en[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export const t = (key: Key, params?: Params): string => translate(store.get(), key, params);

/** Components call this so that they render again when the language is switched. */
export function useT(): (key: Key, params?: Params) => string {
  const lang = useStore(store);
  return (key, params) => translate(lang, key, params);
}

export const useLang = (): [Lang, (l: Lang) => void] => [useStore(store), setLang];
