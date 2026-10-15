import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AnthropicStreamTranslator, finishReason, fromAnthropicMessage, toAnthropicRequest, usageFrom, type TranslateOptions } from '../adapters/anthropic-translate.js';
import { HubError } from '../errors.js';
import { parseSse, sendJson, sendSse, startHub, startUpstream, type Json, type TestHub, type Upstream } from './helpers.js';

const opts: TranslateOptions = { model: 'claude-test', stream: false, defaultMaxTokens: 4096, maxOutputTokens: null };
const req = (body: Json, o: Partial<TranslateOptions> = {}) => toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }], ...body }, { ...opts, ...o });

describe('OpenAI -> Anthropic request translation', () => {
  it('moves system messages up and keeps the conversation', () => {
    const { request } = req({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: 'Use Polish.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
      ],
      temperature: 1.7,
      stop: 'END',
      user: 'u-1',
    });
    assert.equal(request.system, 'Be brief.\n\nUse Polish.');
    assert.deepEqual(request.messages, [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
    ]);
    assert.equal(request.temperature, 1, 'OpenAI allows up to 2, Anthropic up to 1');
    assert.deepEqual(request.stop_sequences, ['END']);
    assert.deepEqual(request.metadata, { user_id: 'u-1' });
    assert.equal(request.max_tokens, 4096, 'Anthropic insists on max_tokens, so there is a default');
    assert.equal(request.model, 'claude-test');
  });

  it('maps tool definitions, tool calls and their results', () => {
    const { request } = req({
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Reads', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
      parallel_tool_calls: false,
      messages: [
        { role: 'user', content: 'read a and b' },
        { role: 'assistant', content: 'Reading.', tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_a', content: 'AAA' },
        { role: 'tool', tool_call_id: 'call_b', content: [{ type: 'text', text: 'BBB' }] },
        { role: 'user', content: 'thanks' },
      ],
    });
    assert.deepEqual(request.tools, [{ name: 'read_file', description: 'Reads', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
    assert.deepEqual(request.tool_choice, { type: 'tool', name: 'read_file', disable_parallel_tool_use: true });
    assert.deepEqual(request.messages[1], {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b' } },
      ],
    });
    // both results and the follow-up share one user turn, results first
    assert.deepEqual(request.messages[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'AAA' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'BBB' },
        { type: 'text', text: 'thanks' },
      ],
    });
    assert.equal(request.messages.length, 3);
  });

  it('maps tool_choice values and drops tools when told not to use them', () => {
    const tools = [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }];
    assert.deepEqual(req({ tools, tool_choice: 'required' }).request.tool_choice, { type: 'any' });
    assert.equal(req({ tools, tool_choice: 'auto' }).request.tool_choice, undefined);
    const none = req({ tools, tool_choice: 'none' }).request;
    assert.equal(none.tools, undefined);
    assert.equal(none.tool_choice, undefined);
  });

  it('sends images as Anthropic image blocks', () => {
    const { request } = req({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
      ] }],
    });
    assert.deepEqual(request.messages[0].content, [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
    ]);
  });

  it('refuses what it cannot honour instead of faking it', () => {
    assert.throws(() => req({ n: 2 }), (e: unknown) => e instanceof HubError && e.code === 'unsupported_parameter');
    assert.throws(() => req({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }), (e: unknown) => e instanceof HubError && e.code === 'unsupported_content');
    assert.throws(() => req({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }] }), (e: unknown) => e instanceof HubError && e.code === 'invalid_content');
    assert.throws(() => req({ messages: [{ role: 'wizard', content: 'x' }] }), (e: unknown) => e instanceof HubError && e.code === 'invalid_messages');
  });

  it('turns reasoning_effort into a thinking budget and leaves sampling alone while thinking', () => {
    const { request } = req({ reasoning_effort: 'medium', temperature: 0.3, top_p: 0.9, max_tokens: 20000 });
    assert.deepEqual(request.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.equal(request.temperature, undefined);
    assert.equal(request.top_p, undefined);
    assert.equal(request.max_tokens, 20000);

    assert.deepEqual(req({ reasoning: { max_tokens: 3000 }, max_tokens: 9000 }).request.thinking, { type: 'enabled', budget_tokens: 3000 });
    assert.deepEqual(req({ thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 9000 }).request.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(req({ thinking: { type: 'disabled' } }).request.thinking, undefined);
  });

  it('keeps the thinking budget below max_tokens, or gives thinking up', () => {
    assert.deepEqual(req({ reasoning_effort: 'high', max_tokens: 5000 }).request.thinking, { type: 'enabled', budget_tokens: 4999 });
    const tiny = req({ reasoning_effort: 'high', max_tokens: 800, temperature: 0.5 });
    assert.equal(tiny.request.thinking, undefined);
    assert.equal(tiny.request.temperature, 0.5, 'without thinking the sampling settings apply again');
    assert.match(tiny.notes.join(' '), /thinking skipped/);
  });

  it('does not ask for thinking mid tool loop unless the previous thinking blocks come back', () => {
    const call = { id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } };
    const loop = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ];
    const skipped = req({ messages: loop, reasoning_effort: 'low', max_tokens: 9000 });
    assert.equal(skipped.request.thinking, undefined);
    assert.match(skipped.notes.join(' '), /reasoning_details/);

    const echoed = req({
      messages: [loop[0], { ...loop[1], reasoning_details: [{ type: 'reasoning.text', text: 'plan', signature: 'sig' }] }, loop[2]],
      reasoning_effort: 'low',
      max_tokens: 9000,
    });
    assert.deepEqual(echoed.request.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.deepEqual(echoed.request.messages[1].content[0], { type: 'thinking', thinking: 'plan', signature: 'sig' });
  });

  it('asks for JSON in words, since the API has no switch for it', () => {
    assert.match(req({ response_format: { type: 'json_object' } }).request.system, /valid JSON object/);
    assert.match(req({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } } }).request.system, /JSON schema/);
  });

  it('respects a known output ceiling when the client did not choose one', () => {
    assert.equal(req({}, { maxOutputTokens: 2000 }).request.max_tokens, 2000);
    assert.equal(req({ max_tokens: 3000 }, { maxOutputTokens: 2000 }).request.max_tokens, 3000);
  });
});

describe('Anthropic -> OpenAI response translation', () => {
  it('maps text, thinking, tool use, stop reasons and usage', () => {
    const out = fromAnthropicMessage({
      id: 'msg_1',
      type: 'message',
      model: 'claude-test',
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig1' },
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    });
    const m = out.choices[0].message;
    assert.equal(m.content, 'Checking. ');
    assert.equal(m.reasoning_content, 'let me think');
    assert.deepEqual(m.reasoning_details, [{ type: 'reasoning.text', text: 'let me think', signature: 'sig1', format: 'anthropic-claude-v1' }]);
    assert.deepEqual(m.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }]);
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(out.usage, { prompt_tokens: 115, completion_tokens: 7, total_tokens: 122, prompt_tokens_details: { cached_tokens: 100 } });
    assert.equal(fromAnthropicMessage({ content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }], stop_reason: 'tool_use' }).choices[0].message.content, null);
    assert.deepEqual(['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn', 'new_thing'].map(finishReason), ['stop', 'length', 'stop', 'content_filter', 'stop', 'stop']);
    assert.equal(usageFrom(undefined).total_tokens, 0);
  });
});

describe('Anthropic stream -> OpenAI chunks', () => {
  it('relays text, thinking and tool calls in order, with tool indexes of their own', () => {
    const t = new AnthropicStreamTranslator();
    const chunks: Json[] = [];
    const feed = (data: Json) => chunks.push(...t.push(undefined, data));
    feed({ type: 'message_start', message: { id: 'msg_1', model: 'claude-test', usage: { input_tokens: 25, output_tokens: 1 } } });
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigX' } });
    feed({ type: 'content_block_stop', index: 0 });
    feed({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } });
    feed({ type: 'content_block_stop', index: 1 });
    feed({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'ls', input: {} } });
    feed({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"dir":' } });
    feed({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"/"}' } });
    feed({ type: 'content_block_stop', index: 2 });
    feed({ type: 'ping' });
    feed({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } });
    feed({ type: 'message_stop' });

    const deltas = chunks.filter(c => c.choices.length).map(c => c.choices[0].delta);
    assert.deepEqual(deltas[0], { role: 'assistant', content: '' });
    assert.equal(deltas.map(d => d.reasoning_content ?? '').join(''), 'hm');
    assert.equal(deltas.map(d => d.content ?? '').join(''), 'Hi there');
    assert.deepEqual(deltas.find(d => d.reasoning_details).reasoning_details, [{ type: 'reasoning.text', text: 'hm', signature: 'sigX', format: 'anthropic-claude-v1' }]);
    const toolDeltas = deltas.flatMap(d => d.tool_calls ?? []);
    assert.deepEqual(toolDeltas[0], { index: 0, id: 'toolu_9', type: 'function', function: { name: 'ls', arguments: '' } });
    assert.equal(toolDeltas.slice(1).map(d => d.function.arguments).join(''), '{"dir":"/"}');
    assert.ok(toolDeltas.every(d => d.index === 0), 'the first tool call is index 0 even though it is Anthropic block 2');
    assert.equal(chunks.at(-2)!.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks.at(-1)!.choices, []);
    assert.deepEqual(chunks.at(-1)!.usage, { prompt_tokens: 25, completion_tokens: 33, total_tokens: 58 });
    assert.ok(t.complete);
  });

  it('turns an error event into an error the hub can act on', () => {
    const t = new AnthropicStreamTranslator();
    t.push(undefined, { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } });
    assert.throws(() => t.push(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), (e: unknown) => e instanceof HubError && e.code === 'upstream_overloaded' && e.fallback);
  });
});

describe('Anthropic upstream through the hub', () => {
  let up: Upstream;
  let h: TestHub;
  let mode = 'text';

  before(async () => {
    up = await startUpstream(async (r, res) => {
      if (r.path === '/v1/models') {
        const page = r.raw === '' && !(r.headers['x-page'] ?? '');
        void page;
        return sendJson(res, 200, { data: [{ id: 'claude-test', display_name: 'Claude Test', max_input_tokens: 200000, max_tokens: 8192 }, { id: 'claude-small', display_name: 'Claude Small' }], has_more: false });
      }
      if (r.path === '/v1/messages') {
        if (mode === 'overloaded') return sendJson(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
        if (mode === 'badkey') return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        if (mode === 'invalid') return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } });
        if (r.body?.['stream']) {
          return void (await sendSse(res, [
            { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_s', model: 'claude-test', usage: { input_tokens: 12, output_tokens: 1 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'ping', data: { type: 'ping' } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]));
        }
        return sendJson(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Hello world' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 } });
      }
      sendJson(res, 404, {});
    });
    h = await startHub({
      setup: async hub => {
        hub.providers.create({ id: 'claude', name: 'Claude', type: 'anthropic', baseUrl: `${up.url}/v1`, apiKey: 'sk-ant-test-0000', locality: 'cloud' });
        await hub.sync.syncOne('claude');
      },
    });
  });

  after(async () => {
    await h.close();
    await up.close();
  });

  const chat = (body: Json = {}) => h.api('POST', '/v1/chat/completions', { model: 'claude/claude-test', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], ...body });

  it('discovers models with what the Anthropic API reports', async () => {
    const r = await h.api('GET', '/v1/models');
    const m = r.json.data.find((x: Json) => x.id === 'claude/claude-test');
    assert.equal(m.name, 'Claude Test');
    assert.equal(m.context_length, 200000);
    assert.deepEqual(m.supports.sort(), ['reasoning_effort', 'tools', 'vision']);
  });

  it('answers in OpenAI format and authenticates the Anthropic way', async () => {
    mode = 'text';
    up.requests.length = 0;
    const r = await chat({ max_tokens: 100 });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'Hello world');
    assert.equal(r.json.usage.total_tokens, 16);
    assert.equal(r.json.model, 'claude/claude-test');
    const sent = up.requests.find(x => x.path === '/v1/messages')!;
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test-0000');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.headers['authorization'], undefined);
    assert.equal(sent.body!['system'], 'sys');
    assert.equal(sent.body!['max_tokens'], 100);
    assert.equal(sent.body!['model'], 'claude-test');
  });

  it('streams in OpenAI format', async () => {
    mode = 'text';
    const r = await chat({ stream: true, stream_options: { include_usage: true } });
    const events = parseSse(r.text);
    const json = events.filter((e): e is Json => typeof e !== 'string');
    assert.equal(json.map(c => c.choices[0]?.delta?.content ?? '').join(''), 'Hello world');
    assert.equal(json.at(-1)!.usage.total_tokens, 16);
    assert.equal(events.at(-1), '[DONE]');
  });

  it('reports Anthropic errors the way the hub reports every upstream error', async () => {
    mode = 'overloaded';
    let r = await chat();
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'upstream_overloaded');
    mode = 'badkey';
    r = await chat();
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'upstream_auth_failed');
    mode = 'invalid';
    r = await chat();
    assert.equal(r.status, 400);
    mode = 'text';
  });

  it('refuses requests Anthropic cannot serve before bothering it', async () => {
    up.requests.length = 0;
    const r = await chat({ n: 3 });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'unsupported_parameter');
    assert.equal(up.requests.filter(x => x.path === '/v1/messages').length, 0);
  });
});
