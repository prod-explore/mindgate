import { describe, expect, it } from 'vitest';
import { en } from './en';
import { pl } from './pl';
import { setLang, t, translate } from './index';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort();

describe('translations', () => {
  const keys = Object.keys(en) as Array<keyof typeof en>;

  it('Polish has exactly the keys English has', () => {
    expect(Object.keys(pl).sort()).toEqual([...keys].sort());
  });

  it('nothing is empty or left with spaces at the edges', () => {
    for (const k of keys) {
      for (const dict of [en, pl] as Array<Record<string, string>>) {
        expect(dict[k], k).toBeTruthy();
        expect(dict[k], k).toBe(dict[k]!.trim());
      }
    }
  });

  it('both languages use the same {placeholders}, or a sentence would lose a value', () => {
    for (const k of keys) expect(placeholders(pl[k]), k).toEqual(placeholders(en[k]));
  });

  it('has no raw "undefined" or leftover template syntax', () => {
    for (const k of keys) for (const text of [en[k], pl[k]]) expect(text, k).not.toMatch(/undefined|\$\{|\[object/);
  });

  it('Polish text is really Polish, not a copy of the English (short technical words aside)', () => {
    const same = keys.filter(k => en[k] === pl[k] && en[k].length > 14);
    expect(same).toEqual([]);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'log.attempts', { n: 3 })).toBe('3 attempts');
    expect(translate('en', 'log.attempts')).toBe('{n} attempts');
    expect(translate('en', 'log.attempts', { other: 1 })).toBe('{n} attempts');
    expect(translate('pl', 'models.count', { shown: 5, total: 20 })).toBe('Pokazano 5 z 20');
  });

  it('follows the language that is set', () => {
    setLang('pl');
    expect(t('common.cancel')).toBe('Anuluj');
    setLang('en');
    expect(t('common.cancel')).toBe('Cancel');
  });
});
