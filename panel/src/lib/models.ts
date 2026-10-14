import type { Locality, Model, ModelKind, ModelPatch, Support } from '../api/types';

export interface ModelFilters {
  q: string;
  provider: string;
  kind: '' | ModelKind;
  locality: '' | Locality;
  /** '' = any, 'on' = enabled only, 'off' = disabled only */
  state: '' | 'on' | 'off';
  tag: string;
}

export const NO_FILTERS: ModelFilters = { q: '', provider: '', kind: '', locality: '', state: '', tag: '' };

export function filtersFromQuery(q: URLSearchParams): ModelFilters {
  const kind = q.get('kind');
  const locality = q.get('locality');
  const state = q.get('state');
  return {
    q: q.get('q') ?? '',
    provider: q.get('provider') ?? '',
    kind: kind && ['chat', 'embedding', 'image', 'tts', 'stt'].includes(kind) ? (kind as ModelKind) : '',
    locality: locality === 'local' || locality === 'cloud' ? locality : '',
    state: state === 'on' || state === 'off' ? state : '',
    tag: q.get('tag') ?? '',
  };
}

export const filtersToQuery = (f: ModelFilters): Record<string, string | undefined> => ({
  q: f.q || undefined,
  provider: f.provider || undefined,
  kind: f.kind || undefined,
  locality: f.locality || undefined,
  state: f.state || undefined,
  tag: f.tag || undefined,
});

/** Every word of the search has to appear somewhere in the id, name, description or tags. */
export function filterModels(models: Model[], f: ModelFilters): Model[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(m => {
    if (f.provider && m.provider !== f.provider) return false;
    if (f.kind && m.kind !== f.kind) return false;
    if (f.locality && m.locality !== f.locality) return false;
    if (f.state === 'on' && !m.enabled) return false;
    if (f.state === 'off' && m.enabled) return false;
    if (f.tag && !m.tags.includes(f.tag)) return false;
    if (words.length) {
      const hay = `${m.id} ${m.name} ${m.description} ${m.tags.join(' ')}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

export const allTags = (models: Model[]): string[] => [...new Set(models.flatMap(m => m.tags))].sort();

export interface ModelDraft {
  name: string;
  description: string;
  kind: ModelKind;
  tags: string[];
  context_length: number | null;
  max_output_tokens: number | null;
  /** null = the provider does not say */
  supports: Support[] | null;
  locality: Locality;
  enabled: boolean;
}

export const draftFromModel = (m: Model): ModelDraft => ({
  name: m.name,
  description: m.description,
  kind: m.kind,
  tags: [...m.tags],
  context_length: m.context_length,
  max_output_tokens: m.max_output_tokens,
  supports: m.supports ? [...m.supports] : null,
  locality: m.locality,
  enabled: m.enabled,
});

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Resettable = 'name' | 'description' | 'kind' | 'tags' | 'context_length' | 'max_output_tokens' | 'supports' | 'locality';
export const RESETTABLE: Resettable[] = ['name', 'description', 'kind', 'tags', 'context_length', 'max_output_tokens', 'supports', 'locality'];

/**
 * What to send: a field the person changed is set; a field they reset goes back to what the provider reports (`null`);
 * everything else is left out, so a save never rewrites what it did not touch.
 */
export function patchFrom(original: Model, draft: ModelDraft, reset: ReadonlySet<Resettable>): ModelPatch {
  const patch: ModelPatch = {};
  const before = draftFromModel(original);
  for (const field of RESETTABLE) {
    if (reset.has(field)) {
      (patch as Record<string, unknown>)[field] = null;
    } else if (!same(before[field], draft[field])) {
      // an emptied number or an unknown capability list is `null`, which also means "back to what the provider says"
      (patch as Record<string, unknown>)[field] = draft[field];
    }
  }
  if (draft.enabled !== original.enabled) patch.enabled = draft.enabled;
  return patch;
}

export const hasOverride = (m: Model, field: Resettable): boolean => m.overrides?.[field] !== undefined;
