import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Response } from 'undici';
import { quotaDetails, upstreamError } from '../upstream.js';

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  upstreamError(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }) as never, 'gemini', 'flash-lite', new Date('2026-07-01T10:00:00Z'));

/** Gemini's OpenAI compatibility endpoint wraps the Google error in an array. */
const google = (details: unknown[], message = 'Quota exceeded for metric') => [{ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details } }];
const RETRY = 'type.googleapis.com/google.rpc.RetryInfo';
const QUOTA = 'type.googleapis.com/google.rpc.QuotaFailure';
const perMinute = { '@type': QUOTA, violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] };
const perDay = { '@type': QUOTA, violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] };

describe('quotaDetails', () => {
  it('reads protobuf duration strings, plain numbers and { seconds, nanos }', () => {
    const delay = (retryDelay: unknown) => quotaDetails(JSON.stringify({ error: { details: [{ '@type': RETRY, retryDelay }] } })).retryDelayS;
    assert.equal(delay('37s'), 37);
    assert.equal(delay('1.402s'), 1.402);
    assert.equal(delay(12), 12);
    assert.equal(delay({ seconds: '3', nanos: 500_000_000 }), 3.5);
    assert.equal(delay('soon'), undefined);
    assert.equal(delay(-4), undefined);
    assert.equal(delay(undefined), undefined);
  });

  it('collects the quota names of every violation, whichever way the body is wrapped', () => {
    const q = quotaDetails(JSON.stringify(google([{ '@type': QUOTA, violations: [{ quotaMetric: 'm1', quotaId: 'i1' }, { quotaId: 'i2' }, null] }, { '@type': 'type.googleapis.com/google.rpc.Help' }])));
    assert.deepEqual(q.quotaNames, ['i1', 'm1', 'i2']);
    assert.deepEqual(quotaDetails(JSON.stringify({ error: { details: [{ '@type': QUOTA, violations: [{ quotaId: 'x' }] }] } })).quotaNames, ['x']);
  });

  it('survives bodies that are not Google errors', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"error":"plain"}', '{"error":{"details":"x"}}', '{"error":{"details":[null,1,"a"]}}']) {
      assert.deepEqual(quotaDetails(text), { quotaNames: [] }, text);
    }
  });
});

describe('upstreamError for 429', () => {
  it('takes the wait from RetryInfo when there is no header, rounded up', async () => {
    const e = await answer(429, google([perMinute, { '@type': RETRY, retryDelay: '1.402s' }]));
    assert.equal(e.code, 'upstream_rate_limited');
    assert.equal(e.headers['Retry-After'], '2');
    assert.equal(e.extra['retry_after_s'], 2);
    assert.equal(e.fallback, true);
  });

  it('reads an unwrapped body and a 37s delay', async () => {
    const e = await answer(429, google([{ '@type': RETRY, retryDelay: '37s' }])[0]);
    assert.equal(e.headers['Retry-After'], '37');
    assert.equal(e.extra['retry_after_s'], 37);
  });

  it('lets the Retry-After header win and adds nothing to the body then', async () => {
    const e = await answer(429, google([{ '@type': RETRY, retryDelay: '37s' }]), { 'Retry-After': '5' });
    assert.equal(e.code, 'upstream_rate_limited');
    assert.equal(e.headers['Retry-After'], '5');
    assert.equal(e.extra['retry_after_s'], undefined);
  });

  it('never advertises a wait of zero', async () => {
    const e = await answer(429, google([{ '@type': RETRY, retryDelay: '0s' }]));
    assert.equal(e.headers['Retry-After'], '1');
  });

  it('without any hint is a plain rate limit with no Retry-After', async () => {
    const e = await answer(429, { error: { message: 'slow down' } });
    assert.equal(e.code, 'upstream_rate_limited');
    assert.equal(e.headers['Retry-After'], undefined);
    assert.equal(e.extra['retry_after_s'], undefined);
  });

  it('a per-day quota is exhausted until midnight Pacific', async () => {
    const e = await answer(429, google([perDay, { '@type': RETRY, retryDelay: '37s' }]));
    assert.equal(e.code, 'upstream_quota_exhausted');
    assert.equal(e.extra['reset_at'], '2026-07-02T07:00:00.000Z'); // PDT (UTC-7)
    assert.equal(e.headers['Retry-After'], String(21 * 3600));
    assert.equal(e.fallback, true);
    assert.equal(e.extra['retry_after_s'], undefined);
  });

  it('matches the quota metric as well as the quota id', async () => {
    const e = await answer(429, google([{ '@type': QUOTA, violations: [{ quotaMetric: 'x/GenerateContentRequestsPerDay', quotaId: 'whatever' }] }]));
    assert.equal(e.code, 'upstream_quota_exhausted');
  });

  it('the day ends at the right instant across the DST change', async () => {
    const at = (iso: string) => upstreamError(new Response(JSON.stringify(google([perDay])), { status: 429 }) as never, 'g', 'm', new Date(iso));
    assert.equal((await at('2026-03-08T12:00:00Z')).extra['reset_at'], '2026-03-09T07:00:00.000Z'); // the day after the switch to PDT
    assert.equal((await at('2026-03-07T12:00:00Z')).extra['reset_at'], '2026-03-08T08:00:00.000Z'); // PST (UTC-8) until it
    assert.equal((await at('2026-11-01T12:00:00Z')).extra['reset_at'], '2026-11-02T08:00:00.000Z'); // back to PST
    assert.equal((await at('2026-01-15T07:59:59Z')).extra['reset_at'], '2026-01-15T08:00:00.000Z');
  });

  it('a delay longer than ten minutes means the day is used up even without a quota name', async () => {
    const e = await answer(429, google([perMinute, { '@type': RETRY, retryDelay: '601s' }]));
    assert.equal(e.code, 'upstream_quota_exhausted');
    assert.equal(e.extra['reset_at'], '2026-07-02T07:00:00.000Z');
    const edge = await answer(429, google([perMinute, { '@type': RETRY, retryDelay: '600s' }]));
    assert.equal(edge.code, 'upstream_rate_limited', 'ten minutes exactly is still a window');
  });

  it('is decided by the shape of the body, not by who sent it', async () => {
    const e = await answer(429, { error: { message: 'x', details: [{ '@type': QUOTA, violations: [{ quotaId: 'RequestsPerDay' }] }] } });
    assert.equal(e.code, 'upstream_quota_exhausted');
  });

  it('keeps the existing handling of an upstream MindGate or OpenAI that names the quota itself', async () => {
    const e = await answer(429, { error: { message: 'used up', code: 'insufficient_quota' } }, { 'Retry-After': '90' });
    assert.equal(e.code, 'upstream_quota_exhausted');
    assert.equal(e.headers['Retry-After'], '90');
  });
});

describe('upstreamError for 503', () => {
  it('passes the upstream\'s Retry-After on', async () => {
    assert.equal((await answer(503, { error: { message: 'busy' } }, { 'Retry-After': '3' })).headers['Retry-After'], '3');
    assert.equal((await answer(529, { error: { message: 'busy' } })).headers['Retry-After'], undefined);
  });
});
