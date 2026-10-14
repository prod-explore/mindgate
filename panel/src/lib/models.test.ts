import { describe, expect, it } from 'vitest';
import { allTags, draftFromModel, filterModels, filtersFromQuery, filtersToQuery, hasOverride, NO_FILTERS, patchFrom } from './models';
import { model } from '../test/fixtures';

const catalog = [
  model({ id: 'home/qwen3:4b', name: 'qwen3:4b', tags: ['fast'] }),
  model({ id: 'home/dolphin3', provider: 'home', name: 'dolphin3', tags: ['uncensored'], enabled: false }),
  model({ id: 'openrouter/deepseek/deepseek-chat', provider: 'openrouter', name: 'DeepSeek V3', locality: 'cloud', description: 'Cheap and good at code' }),
  model({ id: 'openrouter/openai/text-embedding-3-small', provider: 'openrouter', name: 'Embedding small', kind: 'embedding', locality: 'cloud' }),
];
const ids = (list: typeof catalog) => list.map(m => m.id);

describe('filtering the catalog', () => {
  it('shows everything with no filter', () => {
    expect(filterModels(catalog, NO_FILTERS)).toHaveLength(4);
  });
  it('every word of the search has to match somewhere', () => {
    expect(ids(filterModels(catalog, { ...NO_FILTERS, q: 'deepseek code' }))).toEqual(['openrouter/deepseek/deepseek-chat']);
    expect(ids(filterModels(catalog, { ...NO_FILTERS, q: 'DEEPSEEK' }))).toEqual(['openrouter/deepseek/deepseek-chat']);
    expect(filterModels(catalog, { ...NO_FILTERS, q: 'deepseek nonsense' })).toEqual([]);
    expect(ids(filterModels(catalog, { ...NO_FILTERS, q: 'uncensored' }))).toEqual(['home/dolphin3']);
  });
  it('combines the filters', () => {
    expect(ids(filterModels(catalog, { ...NO_FILTERS, provider: 'home', state: 'on' }))).toEqual(['home/qwen3:4b']);
    expect(ids(filterModels(catalog, { ...NO_FILTERS, locality: 'cloud', kind: 'chat' }))).toEqual(['openrouter/deepseek/deepseek-chat']);
    expect(ids(filterModels(catalog, { ...NO_FILTERS, state: 'off' }))).toEqual(['home/dolphin3']);
    expect(ids(filterModels(catalog, { ...NO_FILTERS, tag: 'fast' }))).toEqual(['home/qwen3:4b']);
  });
  it('lists the tags in use', () => {
    expect(allTags(catalog)).toEqual(['fast', 'uncensored']);
  });
});

describe('filters in the address', () => {
  it('round-trips', () => {
    const f = { q: 'qwen', provider: 'home', kind: 'chat' as const, locality: 'local' as const, state: 'on' as const, tag: 'fast' };
    const q = new URLSearchParams(Object.entries(filtersToQuery(f)).flatMap(([k, v]) => (v ? [[k, v]] : [])));
    expect(filtersFromQuery(q)).toEqual(f);
  });
  it('leaves empty filters out and ignores nonsense values', () => {
    expect(Object.values(filtersToQuery(NO_FILTERS)).every(v => v === undefined)).toBe(true);
    expect(filtersFromQuery(new URLSearchParams('kind=banana&locality=moon&state=maybe'))).toEqual(NO_FILTERS);
  });
});

describe('saving an edit', () => {
  const original = model({ tags: ['fast'], supports: ['tools'], overrides: { name: 'qwen3:4b' }, reported: { name: 'qwen3' } });

  it('sends only what changed', () => {
    const d = { ...draftFromModel(original), name: 'My Qwen', tags: ['fast', 'daily'] };
    expect(patchFrom(original, d, new Set())).toEqual({ name: 'My Qwen', tags: ['fast', 'daily'] });
    expect(patchFrom(original, draftFromModel(original), new Set())).toEqual({});
  });
  it('a reset field goes back to what the provider says (null), whatever the draft shows', () => {
    const d = { ...draftFromModel(original), name: 'ignored' };
    expect(patchFrom(original, d, new Set(['name']))).toEqual({ name: null });
  });
  it('turning a model off or on is part of the same save', () => {
    expect(patchFrom(original, { ...draftFromModel(original), enabled: false }, new Set())).toEqual({ enabled: false });
  });
  it('an emptied context length is null, "back to unknown"', () => {
    expect(patchFrom(original, { ...draftFromModel(original), context_length: null }, new Set())).toEqual({ context_length: null });
  });
  it('knows which fields the person has overridden', () => {
    expect(hasOverride(original, 'name')).toBe(true);
    expect(hasOverride(original, 'description')).toBe(false);
  });
  it('does not share arrays with the model it was made from', () => {
    const d = draftFromModel(original);
    d.tags.push('x');
    expect(original.tags).toEqual(['fast']);
  });
});
