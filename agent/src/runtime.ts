/**
 * What the agent needs from the program that actually runs models.
 *
 * Ollama implements it (ollama.ts). The rest of the agent only talks to this interface, so another runtime
 * (llama.cpp server, a speech or image engine) is one more file that implements it, not a rewrite.
 */

export type RuntimeModelKind = 'chat' | 'embedding';

export interface RuntimeModel {
  /** The name the runtime knows it by, e.g. "qwen3:4b" or "hf.co/user/repo:Q4_K_M". Also what a client sends as `model`. */
  id: string;
  sizeBytes: number | null;
  digest: string | null;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  /** The longest context the model supports (the agent lowers it to what the runtime is configured to use). */
  contextLength: number | null;
  /** The runtime's own words: completion, vision, tools, thinking, embedding... Null when it does not say (old versions). */
  capabilities: string[] | null;
  kind: RuntimeModelKind;
  tags: string[];
}

export interface LoadedModel {
  id: string;
  sizeBytes: number | null;
  vramBytes: number | null;
  /** When the runtime will unload it if nobody asks for it again. */
  expiresAt: string | null;
}

export interface PullProgress {
  /** What the runtime says it is doing: "pulling manifest", "downloading", "verifying sha256 digest"... */
  phase: string;
  completed: number | null;
  total: number | null;
}

export interface RuntimeHealth {
  ok: boolean;
  version: string | null;
  /** True when the agent started the runtime itself (so it also stops it). */
  managed: boolean;
  error: string | null;
}

export interface Runtime {
  readonly name: string;
  readonly url: string;
  /** Base of the runtime's OpenAI-compatible API, e.g. http://127.0.0.1:11434/v1 — what `/v1/*` is forwarded to. */
  readonly openaiBase: string;

  /** Makes the runtime reachable: adopts a running one or starts one. Throws AgentError(runtime_unavailable) if it cannot. */
  ensureRunning(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<RuntimeHealth>;

  listModels(): Promise<RuntimeModel[]>;
  loaded(): Promise<LoadedModel[]>;
  /** Downloads a model. Resolves when it is complete; rejects on failure or when `signal` aborts. */
  pull(name: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void>;
  remove(name: string): Promise<void>;
  /** Loads a model into memory ahead of the first request. `keepAlive` is the runtime's own notation ("10m", "-1"). */
  load(name: string, keepAlive?: string): Promise<void>;
  unload(name: string): Promise<void>;
}

/** A model name that is safe to hand to the runtime and to put in a URL path. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-:/@+]{0,199}$/;
