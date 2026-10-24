import type { DiscoveredModel } from '../store/models.js';
import type { ProviderRuntime } from '../upstream.js';
import type { ResolvedModel, Usage } from '../types.js';

/** Loosely typed on purpose: the hub passes unknown fields through instead of whitelisting the OpenAI schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed on purpose, see above
export type Json = Record<string, any>;

export interface ChatCall {
  runtime: ProviderRuntime;
  model: ResolvedModel;
  /** The client's request as sent (model field still the client's). */
  body: Json;
  stream: boolean;
  signal: AbortSignal;
}

export type StreamItem = { kind: 'chunk'; chunk: Json } | { kind: 'comment'; text: string };

export type ChatResult = { stream: false; json: Json } | { stream: true; events: AsyncGenerator<StreamItem, void, void> };

export interface Adapter {
  chat(call: ChatCall): Promise<ChatResult>;
  embeddings?(call: ChatCall): Promise<Json>;
  listModels(runtime: ProviderRuntime, signal: AbortSignal): Promise<DiscoveredModel[]>;
}

export function usageOf(obj: unknown): Usage | null {
  const u = (obj as Json | null | undefined)?.['usage'] as Json | null | undefined;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? 0);
  const output = Number(u['completion_tokens'] ?? u['output_tokens'] ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input === 0 && output === 0 && u['total_tokens'] === undefined) return null;
  return { inputTokens: Math.max(0, Math.trunc(input)), outputTokens: Math.max(0, Math.trunc(output)) };
}
