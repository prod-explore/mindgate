import type { Json } from './types.js';
import { isPlainObject } from '../util.js';

/**
 * Google's OpenAI-compatible endpoint is stricter than the OpenAI API about three things, and clients should not have to
 * know: function schemas are an OpenAPI subset, tool results must carry the function name, and Gemini 3 insists on a
 * thought signature for every function call it is shown. The hub smooths all three over so a client that speaks plain
 * OpenAI chat completions works against Gemini unchanged.
 */

const GEMINI_HOST = 'generativelanguage.googleapis.com';

/**
 * Google documents this literal for function calls that Gemini did not produce itself (a chat that started on another
 * model, or a client that does not keep the signatures). Without a signature Gemini 3 answers 400.
 */
export const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function isGeminiEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === GEMINI_HOST;
  } catch {
    return false;
  }
}

/**
 * MCP servers emit full JSON Schema (`$schema`, `additionalProperties`, …); Gemini rejects the keys it does not know and
 * an object with an empty `properties` map — which is what every no-argument tool has. Returns undefined when the
 * function should be declared without parameters.
 */
export function sanitizeSchema(schema: unknown): Json | undefined {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (isPlainObject(node)) {
      const out: Json = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$schema' || k === 'additionalProperties') continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  const cleaned = strip(schema);
  if (!isPlainObject(cleaned)) return undefined;
  const props = cleaned['properties'];
  if (cleaned['type'] === 'object' && (!isPlainObject(props) || Object.keys(props).length === 0)) return undefined;
  return cleaned;
}

const hasSignature = (call: Json): boolean => typeof call?.['extra_content']?.['google']?.['thought_signature'] === 'string';

/** A copy of the request body that Gemini's compatibility endpoint accepts. The client's own object is left alone. */
export function adaptRequestForGemini(body: Json): Json {
  const out: Json = { ...body };

  if (Array.isArray(body['tools'])) {
    out['tools'] = body['tools'].map((t: Json) => {
      if (!isPlainObject(t) || !isPlainObject(t['function'])) return t;
      const { parameters, ...fn } = t['function'] as Json;
      const clean = sanitizeSchema(parameters);
      return { ...t, function: clean ? { ...fn, parameters: clean } : fn };
    });
  }

  if (Array.isArray(body['messages'])) {
    const names = new Map<string, string>();
    out['messages'] = body['messages'].map((m: Json) => {
      if (!isPlainObject(m)) return m;
      if (m['role'] === 'assistant' && Array.isArray(m['tool_calls']) && m['tool_calls'].length > 0) {
        const calls = m['tool_calls'] as Json[];
        for (const c of calls) if (typeof c?.['id'] === 'string' && typeof c?.['function']?.['name'] === 'string') names.set(c['id'], c['function']['name']);
        if (calls.some(hasSignature)) return m;
        // Only the first call of a parallel batch carries a signature in real Gemini output.
        return { ...m, tool_calls: [{ ...calls[0], extra_content: { ...(calls[0]?.['extra_content'] ?? {}), google: { thought_signature: DUMMY_THOUGHT_SIGNATURE } } }, ...calls.slice(1)] };
      }
      if (m['role'] === 'tool' && typeof m['name'] !== 'string') {
        const name = typeof m['tool_call_id'] === 'string' ? names.get(m['tool_call_id']) : undefined;
        if (name) return { ...m, name };
      }
      return m;
    });
  }
  return out;
}
