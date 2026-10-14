import { describe, expect, it } from 'vitest';
import { fit, isActivePull, sortPulls, validPullName } from './nodes';
import { pull } from '../test/fixtures';

const gpu = (total: number) => ({ name: 'g', memory_total_bytes: total, memory_used_bytes: 0, utilization_percent: null });

describe('does the model fit in graphics memory', () => {
  it('leaves room next to the weights', () => {
    expect(fit({ size_bytes: 2.6e9, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'fits', vram: 4e9 });
    expect(fit({ size_bytes: 3.6e9, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'fits', vram: 4e9 });
    expect(fit({ size_bytes: 3.7e9, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'spills', vram: 4e9 });
    expect(fit({ size_bytes: 9e9, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'spills', vram: 4e9 });
  });
  it('looks at the biggest card', () => {
    expect(fit({ size_bytes: 7e9, kind: 'chat' }, [gpu(4e9), gpu(8e9)])).toEqual({ kind: 'fits', vram: 8e9 });
  });
  it('knows when there is no card, and when it cannot tell', () => {
    expect(fit({ size_bytes: 1e9, kind: 'chat' }, [])).toEqual({ kind: 'no_gpu' });
    expect(fit({ size_bytes: null, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'unknown' });
    expect(fit({ size_bytes: 0, kind: 'chat' }, [gpu(4e9)])).toEqual({ kind: 'unknown' });
    expect(fit({ size_bytes: 1e9, kind: 'chat' }, undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('downloads', () => {
  it('active ones are the ones that still change', () => {
    expect(isActivePull(pull({ status: 'queued' }))).toBe(true);
    expect(isActivePull(pull({ status: 'running' }))).toBe(true);
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) expect(isActivePull(pull({ status }))).toBe(false);
  });
  it('lists running ones first, then the newest', () => {
    const list = [
      pull({ id: 'old-done', status: 'succeeded', created_at: '2026-10-14T08:00:00Z' }),
      pull({ id: 'new-done', status: 'failed', created_at: '2026-10-14T09:30:00Z' }),
      pull({ id: 'running', status: 'running', created_at: '2026-10-14T07:00:00Z' }),
    ];
    expect(sortPulls(list).map(j => j.id)).toEqual(['running', 'new-done', 'old-done']);
    expect(list.map(j => j.id)).toEqual(['old-done', 'new-done', 'running']); // the input is left alone
  });
  it('accepts Ollama names and Hugging Face files, nothing odd', () => {
    for (const ok of ['qwen3:4b', 'llama3.2:3b', 'nomic-embed-text', 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M', 'library/phi4-mini', ' gemma3:4b ']) expect(validPullName(ok)).toBe(true);
    for (const bad of ['', ' ', 'two words', '-leading', '../etc', 'a;b', 'x'.repeat(201), 'name?x=1']) expect(validPullName(bad)).toBe(false);
  });
});
