import type { ModelKind } from './types.js';

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export function stringArray(v: unknown, max = 32, maxLen = 40): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().toLowerCase().slice(0, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Best guess at what a model does from its id, for upstreams that do not say. */
export function guessKind(id: string): ModelKind {
  const s = id.toLowerCase();
  if (/(^|[-_/:.])(embed|embedding|embeddings|bge|e5|gte|minilm|nomic-embed)([-_/:.]|$)|embed/.test(s)) return 'embedding';
  if (/whisper|transcribe|(^|[-_/])stt([-_/]|$)/.test(s)) return 'stt';
  if (/(^|[-_/])tts([-_/]|$)|text-to-speech|speech-synth/.test(s)) return 'tts';
  if (/dall-?e|imagen|stable-diffusion|sdxl|(^|[-_/])flux([-_/.]|$)|image-gen|gpt-image/.test(s)) return 'image';
  return 'chat';
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
