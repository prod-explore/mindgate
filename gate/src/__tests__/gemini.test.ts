import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DUMMY_THOUGHT_SIGNATURE, adaptRequestForGemini, isGeminiEndpoint, sanitizeSchema } from '../adapters/gemini.js';
import { embeddedClientStatus } from '../upstream.js';
import { addProvider, openaiUpstream, sendJson, startHub, type TestHub, type Upstream } from './helpers.js';

describe('Gemini compatibility smoothing', () => {
  it('recognises only Google\'s endpoint', () => {
    assert.equal(isGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta/openai'), true);
    assert.equal(isGeminiEndpoint('https://openrouter.ai/api/v1'), false);
    assert.equal(isGeminiEndpoint('https://generativelanguage.googleapis.com.evil.example/v1'), false);
    assert.equal(isGeminiEndpoint('not a url'), false);
  });

  it('strips what Gemini\'s function schema does not know and drops empty parameter objects', () => {
    assert.deepEqual(
      sanitizeSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { q: { type: 'string', additionalProperties: false } }, required: ['q'] }),
      { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    );
    assert.equal(sanitizeSchema({ type: 'object', properties: {} }), undefined);
    assert.equal(sanitizeSchema(undefined), undefined);
  });

  it('adds a thought signature to histories that have none, names tool results, and leaves the original body alone', () => {
    const original = {
      model: 'm',
      tools: [{ type: 'function', function: { name: 'now', description: 'time', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'now', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'noon' },
        { role: 'tool', tool_call_id: 'c2', content: 'noon', name: 'kept' },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    const out = adaptRequestForGemini(original);
    assert.deepEqual(original, snapshot, 'the client\'s object is not mutated');
    assert.equal(out['tools'][0].function.parameters, undefined);
    const calls = out['messages'][1].tool_calls;
    assert.equal(calls[0].extra_content.google.thought_signature, DUMMY_THOUGHT_SIGNATURE);
    assert.equal(calls[1].extra_content, undefined, 'only the first call of a batch carries one');
    assert.equal(out['messages'][2].name, 'now');
    assert.equal(out['messages'][3].name, 'kept');
  });

  it('keeps a real signature the client sent back', () => {
    const real = { id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' }, extra_content: { google: { thought_signature: 'REAL' } } };
    const out = adaptRequestForGemini({ messages: [{ role: 'assistant', tool_calls: [real] }] });
    assert.equal(out['messages'][0].tool_calls[0].extra_content.google.thought_signature, 'REAL');
  });
});

describe('embedded client errors behind a 5xx', () => {
  it('finds a 4xx that the model server wrapped, and an unparseable tool call, but leaves retryable ones alone', () => {
    assert.equal(embeddedClientStatus('{"error":"error parsing tool call: raw=\'{\\"a\'"}'), 400);
    assert.equal(embeddedClientStatus('upstream error 422 unprocessable'), 422);
    assert.equal(embeddedClientStatus('upstream status 429 too many'), null);
    assert.equal(embeddedClientStatus('internal server error'), null);
  });
});

describe('a model server that fails on an unparseable tool call', () => {
  let up: Upstream;
  let h: TestHub;
  before(async () => {
    up = await openaiUpstream({
      models: [{ id: 'local-model', object: 'model' }],
      chat: async (_req, res) => sendJson(res, 500, { error: { message: 'error parsing tool call: raw=\'{"city":\'' } }),
    });
    h = await startHub({ setup: hub => addProvider(hub, 'box', up) });
  });
  after(async () => {
    await h.close();
    await up.close();
  });

  it('is reported to the client as a 400 and not retried', async () => {
    up.requests.length = 0;
    const r = await h.api('POST', '/v1/chat/completions', { model: 'box/local-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /error parsing tool call/);
    assert.equal(up.requests.filter(x => x.path.endsWith('/chat/completions')).length, 1);
  });
});
