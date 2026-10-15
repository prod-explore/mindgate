import { describe, expect, it } from 'vitest';
import { en } from './en';
import { t, translate } from './index';

const keys = Object.keys(en) as Array<keyof typeof en>;

describe('texts', () => {
  it('nothing is empty or left with spaces at the edges', () => {
    for (const k of keys) {
      expect(en[k], k).toBeTruthy();
      expect(en[k], k).toBe(en[k].trim());
    }
  });

  it('has no raw "undefined" or leftover template syntax', () => {
    for (const k of keys) expect(en[k], k).not.toMatch(/undefined|\$\{|\[object/);
  });

  it('is English only: no Polish letters', () => {
    for (const k of keys) expect(en[k], k).not.toMatch(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('log.attempts', { n: 3 })).toBe('3 attempts');
    expect(translate('log.attempts')).toBe('{n} attempts');
    expect(translate('log.attempts', { other: 1 })).toBe('{n} attempts');
    expect(t('common.cancel')).toBe('Cancel');
  });
});
