import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretBox, SecretError, generateApiKey, safeEqual, sha256Hex } from '../crypto.js';
import { dayKey, monthStartKey, nextDayStart, nextMonthStart } from '../time.js';
import { loadConfig } from '../config.js';
import { weakSecretReason } from '../secret-check.js';
import { MASTER, ADMIN } from './helpers.js';

describe('secret box', () => {
  it('round-trips, and never produces the same ciphertext twice', () => {
    const box = new SecretBox(MASTER);
    const a = box.seal('provider:x', 'sk-very-secret');
    const b = box.seal('provider:x', 'sk-very-secret');
    assert.notEqual(a, b);
    assert.ok(!a.includes('sk-very-secret'));
    assert.equal(box.open('provider:x', a), 'sk-very-secret');
  });

  it('refuses a ciphertext moved to another row, and one sealed with another master key', () => {
    const box = new SecretBox(MASTER);
    const sealed = box.seal('provider:openrouter', 'key-for-openrouter');
    assert.throws(() => box.open('provider:gemini', sealed), SecretError);
    assert.throws(() => new SecretBox('another-master-key-another-master-key').open('provider:openrouter', sealed), SecretError);
    assert.throws(() => box.open('provider:openrouter', 'garbage'), SecretError);
  });
});

describe('client keys', () => {
  it('are random, recognisable, and stored only as a hash', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.notEqual(a.key, b.key);
    assert.match(a.key, /^mg-[A-Za-z0-9_-]{43}$/);
    assert.equal(a.hash, sha256Hex(a.key));
    assert.ok(a.key.startsWith(a.prefix));
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
  });
});

describe('days and months in the owner\'s time zone', () => {
  it('a day starts at local midnight, not at UTC midnight', () => {
    const tz = 'Europe/Warsaw';
    const t = new Date('2026-10-13T23:30:00Z'); // 01:30 on the 14th in Warsaw (UTC+2)
    assert.equal(dayKey(t, tz), '2026-10-14');
    assert.equal(dayKey(t, 'UTC'), '2026-10-13');
    assert.equal(nextDayStart(t, tz).toISOString(), '2026-10-14T22:00:00.000Z');
    assert.equal(nextDayStart(t, 'UTC').toISOString(), '2026-10-14T00:00:00.000Z');
  });

  it('handles the days that gain or lose an hour', () => {
    const tz = 'Europe/Warsaw';
    // 2026-10-25 is 25 hours long in Poland (clocks go back at 03:00)
    assert.equal(nextDayStart(new Date('2026-10-25T10:00:00Z'), tz).toISOString(), '2026-10-25T23:00:00.000Z');
    assert.equal(nextDayStart(new Date('2026-10-24T10:00:00Z'), tz).toISOString(), '2026-10-24T22:00:00.000Z');
    // 2026-03-29 is 23 hours long (clocks go forward)
    assert.equal(nextDayStart(new Date('2026-03-29T10:00:00Z'), tz).toISOString(), '2026-03-29T22:00:00.000Z');
  });

  it('months', () => {
    const tz = 'Europe/Warsaw';
    const t = new Date('2026-10-31T23:30:00Z'); // already November in Warsaw
    assert.equal(monthStartKey(t, tz), '2026-11-01');
    assert.equal(nextMonthStart(new Date('2026-10-13T12:00:00Z'), tz).toISOString(), '2026-10-31T23:00:00.000Z');
    assert.equal(nextMonthStart(new Date('2026-12-13T12:00:00Z'), 'UTC').toISOString(), '2027-01-01T00:00:00.000Z');
  });
});

describe('startup configuration', () => {
  it('needs both secrets, strong and different', () => {
    assert.throws(() => loadConfig({}), /MINDGATE_MASTER_KEY is required/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: MASTER }), /MINDGATE_ADMIN_TOKEN is required/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: 'change-me', MINDGATE_ADMIN_TOKEN: ADMIN }), /too weak/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: 'short', MINDGATE_ADMIN_TOKEN: ADMIN }), /shorter than/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: MASTER }), /must differ/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_USAGE_TZ: 'Mars/Olympus' }), /not a valid IANA time zone/);
    assert.throws(() => loadConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_PORT: 'abc' }), /MINDGATE_PORT/);
    const warnings: string[] = [];
    loadConfig({ MINDGATE_MASTER_KEY: 'password', MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_ALLOW_WEAK_SECRETS: 'true' }, m => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.equal(weakSecretReason(MASTER), null);
  });
});
