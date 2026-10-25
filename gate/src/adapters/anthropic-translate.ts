import { HubError, badRequest } from '../errors.js';
import { isPlainObject } from '../util.js';
import type { Json } from './types.js';

/**
 * OpenAI chat completions <-> Anthropic Messages.
 *
 * The aim is that a client written against the OpenAI API behaves the same against an Anthropic model: messages,
 * images, tool calls and their results, streaming, token usage, and extended thinking (as `reasoning_content`).
 * What has no Anthropic equivalent (logprobs, penalties, seed, n > 1) is ignored or refused, never faked.
 */

export interface TranslateOptions {
  model: string;
  stream: boolean;
  /** Anthropic insists on max_tokens; used when the client sent none. */
  defaultMaxTokens: number;
  /** Known ceiling of the model's output, when the owner or the API told us. */
  maxOutputTokens: number | null;
}

export interface Translated {
  request: Json;
  /** Things the hub changed on purpose that a client might wonder about (thinking skipped, and why). */
  notes: string[];
}

const EFFORT_BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 };
const MIN_THINKING_BUDGET = 1024;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : isPlainObject(p) && p['type'] === 'text' && typeof p['text'] === 'string' ? p['text'] : ''))
      .join('');
  }
  return '';
}

function imageBlock(part: Json): Json {
  const ref = isPlainObject(part['image_url']) ? part['image_url']['url'] : part['image_url'];
  if (typeof ref !== 'string' || !ref) throw badRequest('invalid_content', 'image_url needs a url', 'messages');
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(ref);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(ref)) return { type: 'image', source: { type: 'url', url: ref } };
  throw badRequest('invalid_content', 'image_url must be an http(s) URL or a base64 data URL', 'messages');
}

function userBlocks(content: unknown): Json[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Json[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
    } else if (isPlainObject(part) && part['type'] === 'text') {
      if (typeof part['text'] === 'string' && part['text']) blocks.push({ type: 'text', text: part['text'] });
    } else if (isPlainObject(part) && part['type'] === 'image_url') {
      blocks.push(imageBlock(part));
    } else {
      throw badRequest('unsupported_content', `message content of type "${isPlainObject(part) ? String(part['type']) : typeof part}" is not supported for Anthropic models`, 'messages');
    }
  }
  return blocks;
}

function parseArguments(args: unknown): Json {
  if (isPlainObject(args)) return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const v = JSON.parse(args) as unknown;
    return isPlainObject(v) ? v : { value: v };
  } catch {
    return {};
  }
}

/** Thinking blocks a previous answer carried (see `reasoning_details` in the response), put back in front of the turn. */
function thinkingBlocks(details: unknown): Json[] {
  if (!Array.isArray(details)) return [];
  const out: Json[] = [];
  for (const d of details) {
    if (!isPlainObject(d)) continue;
    if (d['type'] === 'reasoning.text' && typeof d['text'] === 'string' && typeof d['signature'] === 'string') {
      out.push({ type: 'thinking', thinking: d['text'], signature: d['signature'] });
    } else if (d['type'] === 'reasoning.encrypted' && typeof d['data'] === 'string') {
      out.push({ type: 'redacted_thinking', data: d['data'] });
    }
  }
  return out;
}

function pushUser(out: Json[], blocks: Json[]): void {
  if (!blocks.length) return;
  const last = out[out.length - 1];
  if (last && last['role'] === 'user') {
    const merged = [...(last['content'] as Json[]), ...blocks];
    // tool_result blocks must come first in the turn that answers a tool_use
    last['content'] = [...merged.filter(b => b['type'] === 'tool_result'), ...merged.filter(b => b['type'] !== 'tool_result')];
  } else {
    out.push({ role: 'user', content: blocks });
  }
}

function thinkingBudget(body: Json): number | null {
  if (isPlainObject(body['thinking'])) {
    const t = body['thinking'];
    if (t['type'] === 'disabled') return null;
    if (t['type'] === 'enabled' && typeof t['budget_tokens'] === 'number') return Math.trunc(t['budget_tokens']);
  }
  const reasoning = isPlainObject(body['reasoning']) ? body['reasoning'] : undefined;
  if (reasoning && typeof reasoning['max_tokens'] === 'number') return Math.trunc(reasoning['max_tokens']);
  const effort = typeof body['reasoning_effort'] === 'string' ? body['reasoning_effort'] : typeof reasoning?.['effort'] === 'string' ? (reasoning['effort'] as string) : undefined;
  if (effort && effort in EFFORT_BUDGET) return EFFORT_BUDGET[effort]!;
  return null;
}

export function toAnthropicRequest(body: Json, o: TranslateOptions): Translated {
  const notes: string[] = [];
  if (typeof body['n'] === 'number' && body['n'] > 1) throw badRequest('unsupported_parameter', 'Anthropic models cannot return more than one choice (n must be 1)', 'n');
  if (!Array.isArray(body['messages'])) throw badRequest('invalid_messages', 'messages must be an array', 'messages');

  const system: string[] = [];
  const messages: Json[] = [];
  for (const m of body['messages'] as unknown[]) {
    if (!isPlainObject(m) || typeof m['role'] !== 'string') throw badRequest('invalid_messages', 'every message needs a role', 'messages');
    switch (m['role']) {
      case 'system':
      case 'developer': {
        const t = textOf(m['content']);
        if (t) system.push(t);
        break;
      }
      case 'user':
        pushUser(messages, userBlocks(m['content']));
        break;
      case 'assistant': {
        const blocks: Json[] = [...thinkingBlocks(m['reasoning_details'])];
        const t = textOf(m['content']);
        if (t) blocks.push({ type: 'text', text: t });
        if (Array.isArray(m['tool_calls'])) {
          for (const tc of m['tool_calls'] as unknown[]) {
            if (!isPlainObject(tc) || !isPlainObject(tc['function']) || typeof tc['id'] !== 'string') throw badRequest('invalid_messages', 'tool_calls entries need an id and a function', 'messages');
            blocks.push({ type: 'tool_use', id: tc['id'], name: tc['function']['name'], input: parseArguments(tc['function']['arguments']) });
          }
        }
        if (blocks.length) messages.push({ role: 'assistant', content: blocks });
        break;
      }
      case 'tool': {
        if (typeof m['tool_call_id'] !== 'string') throw badRequest('invalid_messages', 'tool messages need a tool_call_id', 'messages');
        const text = textOf(m['content']);
        pushUser(messages, [{ type: 'tool_result', tool_use_id: m['tool_call_id'], ...(text ? { content: text } : {}) }]);
        break;
      }
      default:
        throw badRequest('invalid_messages', `role "${String(m['role'])}" is not supported`, 'messages');
    }
  }

  // Structured output has no switch on this API; ask for it in words.
  const rf = isPlainObject(body['response_format']) ? body['response_format'] : undefined;
  if (rf?.['type'] === 'json_object') system.push('Respond with a single valid JSON object and nothing else.');
  if (rf?.['type'] === 'json_schema' && isPlainObject(rf['json_schema'])) {
    system.push(`Respond with a single valid JSON value and nothing else, conforming to this JSON schema:\n${JSON.stringify(rf['json_schema']['schema'] ?? rf['json_schema'])}`);
  }

  let maxTokens = typeof body['max_completion_tokens'] === 'number' ? body['max_completion_tokens'] : typeof body['max_tokens'] === 'number' ? body['max_tokens'] : o.defaultMaxTokens;
  if (o.maxOutputTokens && !(typeof body['max_completion_tokens'] === 'number' || typeof body['max_tokens'] === 'number')) maxTokens = Math.min(maxTokens, o.maxOutputTokens);
  maxTokens = Math.max(1, Math.trunc(maxTokens));

  const request: Json = { model: o.model, max_tokens: maxTokens, messages, stream: o.stream };
  if (system.length) request['system'] = system.join('\n\n');

  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
  const anthropicTools: Json[] = [];
  for (const t of tools) {
    if (!isPlainObject(t) || t['type'] !== 'function' || !isPlainObject(t['function'])) continue;
    const fn = t['function'];
    anthropicTools.push({
      name: fn['name'],
      ...(typeof fn['description'] === 'string' && fn['description'] ? { description: fn['description'] } : {}),
      input_schema: isPlainObject(fn['parameters']) ? fn['parameters'] : { type: 'object', properties: {} },
    });
  }
  const choice = body['tool_choice'];
  if (anthropicTools.length && choice !== 'none') {
    request['tools'] = anthropicTools;
    const noParallel = body['parallel_tool_calls'] === false ? { disable_parallel_tool_use: true } : {};
    if (choice === 'required') request['tool_choice'] = { type: 'any', ...noParallel };
    else if (isPlainObject(choice) && isPlainObject(choice['function'])) request['tool_choice'] = { type: 'tool', name: choice['function']['name'], ...noParallel };
    else if (Object.keys(noParallel).length) request['tool_choice'] = { type: 'auto', ...noParallel };
  }

  // Extended thinking. Anthropic wants the thinking blocks of the previous assistant turn back whenever that turn
  // used a tool; an OpenAI-style client cannot supply them (no signatures), so continuing a tool loop runs without.
  let budget = thinkingBudget(body);
  if (budget !== null) {
    const lastAssistant = [...messages].reverse().find(m => m['role'] === 'assistant');
    const first = (lastAssistant?.['content'] as Json[] | undefined)?.[0];
    const hasToolUse = (lastAssistant?.['content'] as Json[] | undefined)?.some(b => b['type'] === 'tool_use');
    const lastIsToolResult = messages[messages.length - 1]?.['role'] === 'user' && (messages[messages.length - 1]!['content'] as Json[]).some(b => b['type'] === 'tool_result');
    if (hasToolUse && lastIsToolResult && first?.['type'] !== 'thinking' && first?.['type'] !== 'redacted_thinking') {
      notes.push('thinking skipped: continuing a tool loop without the previous thinking blocks (echo reasoning_details to keep it)');
      budget = null;
    }
  }
  if (budget !== null) {
    budget = Math.max(MIN_THINKING_BUDGET, budget);
    if (budget >= maxTokens) budget = maxTokens - 1;
    if (budget >= MIN_THINKING_BUDGET) {
      request['thinking'] = { type: 'enabled', budget_tokens: budget };
    } else {
      notes.push(`thinking skipped: max_tokens (${maxTokens}) leaves no room for a ${MIN_THINKING_BUDGET}-token budget`);
    }
  }

  // Sampling: OpenAI allows 0-2 for temperature, Anthropic 0-1; and thinking forbids touching either.
  if (!request['thinking']) {
    if (typeof body['temperature'] === 'number') request['temperature'] = Math.min(1, Math.max(0, body['temperature']));
    if (typeof body['top_p'] === 'number') request['top_p'] = body['top_p'];
  }
  if (typeof body['top_k'] === 'number') request['top_k'] = Math.trunc(body['top_k']);
  const stop = body['stop'];
  if (typeof stop === 'string' && stop) request['stop_sequences'] = [stop];
  else if (Array.isArray(stop) && stop.length) request['stop_sequences'] = stop.filter((s): s is string => typeof s === 'string' && s !== '');
  if (typeof body['user'] === 'string' && body['user']) request['metadata'] = { user_id: body['user'].slice(0, 256) };
  return { request, notes };
}

const STOP_REASON: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

export const finishReason = (r: unknown): string => (typeof r === 'string' ? (STOP_REASON[r] ?? 'stop') : 'stop');

export function usageFrom(u: unknown): Json {
  const x = (isPlainObject(u) ? u : {}) as Json;
  const cacheRead = Number(x['cache_read_input_tokens'] ?? 0);
  const cacheWrite = Number(x['cache_creation_input_tokens'] ?? 0);
  const prompt = Number(x['input_tokens'] ?? 0) + cacheRead + cacheWrite;
  const completion = Number(x['output_tokens'] ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cacheRead || cacheWrite ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
  };
}

export function fromAnthropicMessage(json: Json): Json {
  const content = Array.isArray(json['content']) ? (json['content'] as Json[]) : [];
  let text = '';
  let reasoning = '';
  const toolCalls: Json[] = [];
  const details: Json[] = [];
  for (const b of content) {
    if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
    else if (b['type'] === 'thinking') {
      reasoning += typeof b['thinking'] === 'string' ? b['thinking'] : '';
      if (typeof b['signature'] === 'string') details.push({ type: 'reasoning.text', text: b['thinking'] ?? '', signature: b['signature'], format: 'anthropic-claude-v1' });
    } else if (b['type'] === 'redacted_thinking' && typeof b['data'] === 'string') details.push({ type: 'reasoning.encrypted', data: b['data'], format: 'anthropic-claude-v1' });
    else if (b['type'] === 'tool_use') {
      toolCalls.push({ id: b['id'], type: 'function', function: { name: b['name'], arguments: JSON.stringify(b['input'] ?? {}) } });
    }
  }
  const message: Json = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message['reasoning_content'] = reasoning;
  if (details.length) message['reasoning_details'] = details;
  if (toolCalls.length) message['tool_calls'] = toolCalls;
  return {
    id: json['id'],
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json['model'],
    choices: [{ index: 0, message, finish_reason: finishReason(json['stop_reason']) }],
    usage: usageFrom(json['usage']),
  };
}

/**
 * Converts Anthropic's stream events into OpenAI chunks, one event at a time.
 * Tool calls are indexed by their order among tool blocks (Anthropic's own index counts text blocks too).
 */
export class AnthropicStreamTranslator {
  private id = '';
  private model = '';
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly toolIndex = new Map<number, number>();
  private readonly thinking = new Map<number, { text: string; signature: string }>();
  private usage: Json = {};
  private finish: string | null = null;
  private started = false;

  private chunk(delta: Json, finish_reason: string | null = null): Json {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason }] };
  }

  /** Feeds one SSE event; returns the chunks it produces (possibly none). */
  push(event: string | undefined, data: Json): Json[] {
    const type = (data['type'] as string | undefined) ?? event;
    switch (type) {
      case 'message_start': {
        const msg = (data['message'] ?? {}) as Json;
        this.id = String(msg['id'] ?? '');
        this.model = String(msg['model'] ?? '');
        this.usage = { ...(isPlainObject(msg['usage']) ? msg['usage'] : {}) };
        this.started = true;
        return [this.chunk({ role: 'assistant', content: '' })];
      }
      case 'content_block_start': {
        const block = (data['content_block'] ?? {}) as Json;
        const index = Number(data['index']);
        if (block['type'] === 'tool_use') {
          const ti = this.toolIndex.size;
          this.toolIndex.set(index, ti);
          return [this.chunk({ tool_calls: [{ index: ti, id: block['id'], type: 'function', function: { name: block['name'], arguments: '' } }] })];
        }
        if (block['type'] === 'thinking') this.thinking.set(index, { text: '', signature: '' });
        if (block['type'] === 'redacted_thinking' && typeof block['data'] === 'string') {
          return [this.chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: block['data'], format: 'anthropic-claude-v1' }] })];
        }
        return [];
      }
      case 'content_block_delta': {
        const d = (data['delta'] ?? {}) as Json;
        const index = Number(data['index']);
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') return d['text'] ? [this.chunk({ content: d['text'] })] : [];
        if (d['type'] === 'thinking_delta' && typeof d['thinking'] === 'string') {
          const t = this.thinking.get(index);
          if (t) t.text += d['thinking'];
          return [this.chunk({ reasoning_content: d['thinking'] })];
        }
        if (d['type'] === 'signature_delta' && typeof d['signature'] === 'string') {
          const t = this.thinking.get(index);
          if (t) t.signature += d['signature'];
          return [];
        }
        if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string') {
          const ti = this.toolIndex.get(index);
          if (ti === undefined || !d['partial_json']) return [];
          return [this.chunk({ tool_calls: [{ index: ti, function: { arguments: d['partial_json'] } }] })];
        }
        return [];
      }
      case 'content_block_stop': {
        const t = this.thinking.get(Number(data['index']));
        if (t && t.signature) {
          this.thinking.delete(Number(data['index']));
          return [this.chunk({ reasoning_details: [{ type: 'reasoning.text', text: t.text, signature: t.signature, format: 'anthropic-claude-v1' }] })];
        }
        return [];
      }
      case 'message_delta': {
        const d = (data['delta'] ?? {}) as Json;
        if (d['stop_reason']) this.finish = finishReason(d['stop_reason']);
        if (isPlainObject(data['usage'])) this.usage = { ...this.usage, ...data['usage'] };
        return [];
      }
      case 'message_stop':
        return [this.chunk({}, this.finish ?? 'stop'), { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: usageFrom(this.usage) }];
      case 'error': {
        const e = (data['error'] ?? {}) as Json;
        throw new HubError({
          status: e['type'] === 'overloaded_error' ? 503 : e['type'] === 'rate_limit_error' ? 429 : 502,
          code: e['type'] === 'overloaded_error' ? 'upstream_overloaded' : e['type'] === 'rate_limit_error' ? 'upstream_rate_limited' : 'upstream_error',
          message: typeof e['message'] === 'string' ? e['message'] : 'the upstream reported an error mid-answer',
          fallback: true,
        });
      }
      default:
        return []; // ping, and event types this translator does not know
    }
  }

  get complete(): boolean {
    return this.started && this.finish !== null;
  }
}
