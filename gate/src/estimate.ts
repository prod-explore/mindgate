import type { Usage } from './types.js';

/**
 * Upstreams that report no usage still get counted, roughly: about four characters per token. Good enough to keep a
 * budget honest; the request log marks such numbers as estimated.
 */
export const roughTokens = (chars: number): number => Math.ceil(chars / 4);

export function estimateInput(body: Record<string, unknown>): number {
  let chars = 0;
  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const c = (m as { content?: unknown }).content;
      if (typeof c === 'string') chars += c.length;
      else if (Array.isArray(c)) {
        for (const p of c) {
          const part = p as { type?: string; text?: string };
          if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
          else if (part.type === 'image_url') chars += 3000; // an image costs on the order of a thousand tokens
        }
      }
      const calls = (m as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(calls)) chars += JSON.stringify(calls).length;
    }
  }
  if (Array.isArray(body['tools'])) chars += JSON.stringify(body['tools']).length;
  const input = body['input'];
  if (typeof input === 'string') chars += input.length;
  else if (Array.isArray(input)) chars += input.reduce<number>((n, x) => n + (typeof x === 'string' ? x.length : 0), 0);
  return roughTokens(chars);
}

export const estimated = (inputTokens: number, outputChars: number): Usage => ({ inputTokens, outputTokens: roughTokens(outputChars), estimated: true });
