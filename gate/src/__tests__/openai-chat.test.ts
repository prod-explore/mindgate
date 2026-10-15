import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addProvider,
  chunk,
  completion,
  openaiUpstream,
  parseSse,
  sendJson,
  sendSse,
  sleep,
  startHub,
  startUpstream,
  textStream,
  usageChunk,
  type TestHub,
  type Upstream,
} from './helpers.js';

describe('OpenAI-compatible upstream through the hub', () => {
  let up: Upstream;
  let h: TestHub;
  let mode: 'echo' | 'tools' | 'reasoning' | 'ignore-stream' | 'rate-limit' | 'bad-key' | 'context' | 'boom' | 'cut' | 'no-usage' = 'echo';

  before(async () => {
    up = await openaiUpstream({
      models: [
        { id: 'fake-model', object: 'model', context_length: 32000, supported_parameters: ['tools', 'temperature'], architecture: { input_modalities: ['text', 'image'] } },
        { id: 'text-embedding-3', object: 'model' },
      ],
      chat: async (req, res) => {
        const stream = req.body?.['stream'] === true;
        switch (mode) {
          case 'tools': {
            const hasResult = (req.body?.['messages'] as any[]).some(m => m.role === 'tool');
            if (hasResult) return sendJson(res, 200, completion('It is 21 degrees.'));
            const call = { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Katowice"}' } };
            if (stream) {
              return void (await sendSse(res, [
                chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '' } }] }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '"Katowice"}' } }] }),
                chunk({}, 'tool_calls'),
                usageChunk(20, 8),
                '[DONE]',
              ]));
            }
            return sendJson(res, 200, completion(null, { message: { tool_calls: [call] }, finish_reason: 'tool_calls' }));
          }
          case 'reasoning':
            if (stream) return void (await sendSse(res, [chunk({ role: 'assistant', reasoning: 'hmm' }), chunk({ content: 'ok' }), chunk({}, 'stop'), usageChunk(), '[DONE]']));
            return sendJson(res, 200, completion('ok', { message: { reasoning: 'thinking out loud' } }));
          case 'ignore-stream':
            return sendJson(res, 200, completion('all at once'));
          case 'rate-limit':
            return sendJson(res, 429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, { 'Retry-After': '7' });
          case 'bad-key':
            return sendJson(res, 401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
          case 'context':
            return sendJson(res, 400, { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } });
          case 'boom':
            return sendJson(res, 500, { error: { message: 'kaboom' } });
          case 'cut':
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'half an ans' }))}\n\n`);
            await sleep(20);
            res.destroy();
            return;
          case 'no-usage':
            return void (await sendSse(res, textStream(['one ', 'two'], false)));
          default: {
            const text = `echo: ${(req.body?.['messages'] as any[]).at(-1)?.content}`;
            if (stream) return void (await sendSse(res, textStream(text.split(/(?<= )/), req.body?.['stream_options']?.include_usage === true)));
            return sendJson(res, 200, completion(text));
          }
        }
      },
    });
    h = await startHub({ setup: hub => addProvider(hub, 'fake', up) });
  });

  after(async () => {
    await h.close();
    await up.close();
  });

  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) => h.api('POST', '/v1/chat/completions', { model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }], ...body }, headers);

  it('lists what the upstream reported, with the hub\'s extra fields', async () => {
    const r = await h.api('GET', '/v1/models');
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'list');
    const m = r.json.data.find((x: any) => x.id === 'fake/fake-model');
    assert.equal(m.object, 'model');
    assert.equal(m.owned_by, 'fake');
    assert.equal(m.kind, 'chat');
    assert.equal(m.locality, 'cloud'); // never local unless the owner says so
    assert.equal(m.status, 'online');
    assert.equal(m.context_length, 32000);
    assert.deepEqual(m.supports.sort(), ['tools', 'vision']);
    assert.ok(m.supported_parameters.includes('tools'));
    assert.deepEqual(m.architecture.input_modalities, ['text', 'image']);
    const e = r.json.data.find((x: any) => x.id === 'fake/text-embedding-3');
    assert.equal(e.kind, 'embedding');
    assert.equal(e.supports, undefined, 'capabilities the upstream did not report are left out, not set to "none"');
  });

  it('answers a plain request and tells the client which model replied', async () => {
    mode = 'echo';
    up.requests.length = 0;
    const r = await chat({ temperature: 0.2, top_k: 40, seed: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'echo: hi');
    assert.equal(r.json.model, 'fake/fake-model');
    assert.deepEqual(r.json.mindgate, { requested: 'fake/fake-model', model: 'fake/fake-model', provider: 'fake', attempts: [{ model: 'fake/fake-model', outcome: 'ok' }] });
    assert.equal(r.headers.get('x-mindgate-model'), 'fake/fake-model');
    assert.equal(r.headers.get('x-mindgate-provider'), 'fake');
    assert.match(r.headers.get('x-request-id') ?? '', /^req_/);
    const seen = up.requests.find(x => x.path === '/v1/chat/completions')!;
    assert.equal(seen.body!['model'], 'fake-model', 'the upstream gets its own name for the model');
    assert.equal(seen.body!['top_k'], 40, 'parameters the hub does not know about still reach the upstream');
    assert.equal(seen.body!['seed'], 7);
    assert.equal(seen.body!['stream'], false);
    assert.equal(seen.headers['authorization'], 'Bearer sk-test-key-1234');
    assert.equal(r.json.usage.total_tokens, 15);
  });

  it('echoes a caller\'s X-Request-Id', async () => {
    const r = await chat({}, { 'X-Request-Id': 'trace-abc-123' });
    assert.equal(r.headers.get('x-request-id'), 'trace-abc-123');
  });

  it('streams, forcing usage reporting upstream but showing it only to clients that asked', async () => {
    mode = 'echo';
    up.requests.length = 0;
    const quiet = await chat({ stream: true });
    assert.equal(quiet.status, 200);
    assert.match(quiet.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = parseSse(quiet.text);
    assert.equal(events.at(-1), '[DONE]');
    const json = events.filter((e): e is Record<string, any> => typeof e !== 'string');
    assert.equal(json.map(c => c.choices[0]?.delta?.content ?? '').join(''), 'echo: hi');
    assert.ok(json.every(c => c.model === 'fake/fake-model'));
    assert.ok(!json.some(c => c.choices.length === 0), 'no usage-only chunk for a client that did not ask');
    assert.equal(up.requests.find(x => x.path === '/v1/chat/completions')!.body!['stream_options'].include_usage, true);

    const loud = await chat({ stream: true, stream_options: { include_usage: true } });
    const last = parseSse(loud.text).filter((e): e is Record<string, any> => typeof e !== 'string').at(-1)!;
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage.total_tokens, 15);
  });

  it('adds a usage chunk itself when the upstream never reports usage and the client asked for it', async () => {
    mode = 'no-usage';
    const r = await chat({ stream: true, stream_options: { include_usage: true } });
    const last = parseSse(r.text).filter((e): e is Record<string, any> => typeof e !== 'string').at(-1)!;
    assert.deepEqual(last.choices, []);
    assert.ok(last.usage.completion_tokens >= 1);
    assert.ok(last.usage.prompt_tokens >= 1);
  });

  it('carries a whole tool-calling round trip, streamed and not', async () => {
    mode = 'tools';
    const tools = [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const first = await chat({ tools, tool_choice: 'auto' });
    const call = first.json.choices[0].message.tool_calls[0];
    assert.equal(first.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(call.function.name, 'weather');

    up.requests.length = 0;
    const messages = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '21C' },
    ];
    const second = await chat({ messages, tools });
    assert.equal(second.json.choices[0].message.content, 'It is 21 degrees.');
    const sent = up.requests.find(x => x.path === '/v1/chat/completions')!.body!;
    assert.deepEqual(sent['messages'], messages, 'history, tool calls and tool results are forwarded untouched');
    assert.deepEqual(sent['tools'], tools);

    const streamed = await chat({ tools, stream: true });
    const deltas = parseSse(streamed.text).filter((e): e is Record<string, any> => typeof e !== 'string').flatMap(c => c.choices.map((x: any) => x.delta));
    const args = deltas.flatMap(d => d.tool_calls ?? []).map((t: any) => t.function.arguments ?? '').join('');
    assert.equal(args, '{"city":"Katowice"}');
  });

  it('exposes reasoning as reasoning_content whatever the upstream calls it', async () => {
    mode = 'reasoning';
    const r = await chat({});
    assert.equal(r.json.choices[0].message.reasoning_content, 'thinking out loud');
    const s = await chat({ stream: true });
    const first = parseSse(s.text).find((e): e is Record<string, any> => typeof e !== 'string')!;
    assert.equal(first.choices[0].delta.reasoning_content, 'hmm');
  });

  it('replays an upstream that ignores stream=true as a stream', async () => {
    mode = 'ignore-stream';
    const r = await chat({ stream: true });
    const text = parseSse(r.text).filter((e): e is Record<string, any> => typeof e !== 'string').map(c => c.choices[0]?.delta?.content ?? '').join('');
    assert.equal(text, 'all at once');
  });

  it('maps upstream failures to errors the client can act on', async () => {
    mode = 'rate-limit';
    let r = await chat({});
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'upstream_rate_limited');
    assert.equal(r.json.error.provider, 'fake');
    assert.equal(r.headers.get('retry-after'), '7');

    mode = 'bad-key';
    r = await chat({});
    assert.equal(r.status, 502, "the hub's upstream credentials failing is not the client's 401");
    assert.equal(r.json.error.code, 'upstream_auth_failed');

    mode = 'context';
    r = await chat({});
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'context_length_exceeded', "the upstream's own code survives so clients can react to it");

    mode = 'boom';
    r = await chat({});
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'upstream_error');
    assert.equal(r.json.error.type, 'server_error');
  });

  it('says so inside the stream when the upstream breaks after the answer began', async () => {
    mode = 'cut';
    const r = await chat({ stream: true });
    assert.equal(r.status, 200);
    const events = parseSse(r.text);
    assert.equal((events[0] as any).choices[0].delta.content, 'half an ans');
    const err = events.find((e): e is Record<string, any> => typeof e !== 'string' && 'error' in e)!;
    assert.equal(err.error.code, 'upstream_stream_interrupted');
    assert.equal(events.at(-1), '[DONE]');
  });

  it('reports an unreachable upstream', async () => {
    const dead = await startUpstream((_, res) => {
      res.end();
    });
    const url = dead.url;
    await dead.close();
    h.hub.providers.create({ id: 'dead', type: 'openai', baseUrl: `${url}/v1`, name: 'dead' });
    h.hub.models.addManual('dead', 'm', {});
    const r = await h.api('POST', '/v1/chat/completions', { model: 'dead/m', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'upstream_unreachable');
  });

  it('proxies embeddings', async () => {
    const r = await h.api('POST', '/v1/embeddings', { model: 'fake/text-embedding-3', input: 'hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data[0].embedding, [0.1, 0.2]);
    assert.equal(r.json.model, 'fake/text-embedding-3');
    const wrong = await h.api('POST', '/v1/embeddings', { model: 'fake/fake-model', input: 'hello' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, 'wrong_model_kind');
    const chatOnEmbedding = await chat({ model: 'fake/text-embedding-3' });
    assert.equal(chatOnEmbedding.json.error.code, 'wrong_model_kind');
  });

  it('stops the upstream call and counts what was produced when the client walks away', async () => {
    mode = 'echo';
    const slow = await startUpstream(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'start' }))}\n\n`);
      await new Promise<void>(resolve => {
        res.on('close', () => resolve());
        setTimeout(resolve, 5000);
      });
      slowClosed = true;
    });
    let slowClosed = false;
    h.hub.providers.create({ id: 'slow', type: 'openai', baseUrl: `${slow.url}/v1`, name: 'slow', maxConcurrency: 1 });
    h.hub.models.addManual('slow', 'm', {});
    const ctl = new AbortController();
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.key}` },
      body: JSON.stringify({ model: 'slow/m', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      signal: ctl.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // first bytes arrive
    ctl.abort();
    for (let i = 0; i < 40 && !slowClosed; i++) await sleep(50);
    assert.ok(slowClosed, 'the upstream request was cancelled');
    // the single slot is free again: another request is served at once
    const echo = await h.api('POST', '/v1/chat/completions', { model: 'fake/fake-model', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(echo.status, 200);
    await slow.close();
  });
});
