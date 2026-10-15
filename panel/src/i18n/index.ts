import { en } from './en';

export type Key = keyof typeof en;
export type Params = Record<string, string | number>;

/** Fills `{name}` placeholders; an unknown placeholder stays visible instead of vanishing. */
export function translate(key: Key, params?: Params): string {
  const text = en[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export const t = translate;

/** Components call this to get the translate function (all text lives in en.ts, one place to read and to change). */
export function useT(): (key: Key, params?: Params) => string {
  return translate;
}
