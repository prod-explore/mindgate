import { HubError, notFound } from './errors.js';
import type { AliasStore } from './store/aliases.js';
import type { ModelStore } from './store/models.js';
import type { ProviderStore } from './store/providers.js';
import type { AliasRecord, ApiKeyRecord, ModelKind, ProviderRecord, ResolvedModel } from './types.js';

export interface Candidate {
  model: ResolvedModel;
  provider: ProviderRecord;
}

export interface Resolution {
  requested: string;
  alias: AliasRecord | null;
  /** In the order they are tried. Later ones are used only when an earlier one fails. */
  candidates: Candidate[];
  /** Targets that were left out and why (provider disabled, not local...). */
  skipped: Array<{ model: string; reason: string }>;
}

export interface ResolveOptions {
  /** The request must not reach a model that runs outside the owner's hardware, fallbacks included. */
  localOnly: boolean;
  kind?: ModelKind;
}

export interface ListedModel {
  id: string;
  type: 'model' | 'alias';
  providerId: string | null;
  name: string;
  description: string;
  kind: ModelKind;
  tags: string[];
  contextLength: number | null;
  supports: string[] | null;
  locality: 'local' | 'cloud';
  /** Models behind an alias, in fallback order. */
  targets?: string[];
  primary: Candidate;
}

/** `*`, an exact id or alias name, or `provider/*`. */
export function allowedBy(patterns: string[] | null, name: string): boolean {
  if (patterns === null) return true;
  return patterns.some(p => p === '*' || p === name || (p.endsWith('/*') && name.startsWith(p.slice(0, -1))));
}

export class Router {
  constructor(
    private readonly models: ModelStore,
    private readonly aliases: AliasStore,
    private readonly providers: ProviderStore,
  ) {}

  private candidatesFor(ids: string[], providers: Map<string, ProviderRecord>, skipped: Resolution['skipped']): Candidate[] {
    const out: Candidate[] = [];
    for (const id of ids) {
      const model = this.models.get(id);
      if (!model) {
        skipped.push({ model: id, reason: 'unknown_model' });
        continue;
      }
      const provider = providers.get(model.providerId);
      if (!provider || !provider.enabled) skipped.push({ model: id, reason: 'provider_disabled' });
      else if (!model.enabled) skipped.push({ model: id, reason: 'model_disabled' });
      else out.push({ model, provider });
    }
    return out;
  }

  resolve(name: string, key: ApiKeyRecord, opts: ResolveOptions): Resolution {
    const requested = name.trim();
    const providers = new Map(this.providers.list().map(p => [p.id, p]));
    const skipped: Resolution['skipped'] = [];
    let alias: AliasRecord | null = null;
    let ids: string[];

    if (requested.includes('/')) {
      if (!this.models.getRecord(requested)) throw notFound('model_not_found', `The model "${requested}" does not exist. List the available ones with GET /v1/models.`);
      ids = [requested];
    } else {
      alias = this.aliases.get(requested) ?? null;
      if (!alias || !alias.enabled) throw notFound('model_not_found', `The model "${requested}" does not exist. List the available ones with GET /v1/models.`);
      ids = alias.targets;
    }

    if (!allowedBy(key.allowedModels, requested)) {
      throw new HubError({ status: 403, code: 'model_not_allowed', message: `The key "${key.name}" is not allowed to use "${requested}"`, param: 'model' });
    }

    let candidates = this.candidatesFor(ids, providers, skipped);

    if (opts.kind) {
      const wrong = candidates.filter(c => c.model.kind !== opts.kind);
      for (const c of wrong) skipped.push({ model: c.model.id, reason: `kind_${c.model.kind}` });
      candidates = candidates.filter(c => c.model.kind === opts.kind);
      if (!candidates.length && wrong.length) {
        const use = wrong[0]!.model.kind === 'embedding' ? 'POST /v1/embeddings' : 'an endpoint for that kind of model';
        throw new HubError({ status: 400, code: 'wrong_model_kind', message: `"${requested}" is a ${wrong[0]!.model.kind} model and cannot be used here; use ${use}`, param: 'model' });
      }
    }

    if (opts.localOnly) {
      const nonLocal = candidates.filter(c => c.model.locality !== 'local');
      for (const c of nonLocal) skipped.push({ model: c.model.id, reason: 'local_only' });
      candidates = candidates.filter(c => c.model.locality === 'local');
      if (!candidates.length && nonLocal.length) {
        throw new HubError({
          status: 403,
          code: 'local_only_violation',
          message: `"${requested}" has no model that runs locally, and this request is restricted to local models (the key's local_only setting or the X-MindGate-Local-Only header)`,
          param: 'model',
        });
      }
    }

    if (!candidates.length) {
      throw new HubError({
        status: 503,
        code: 'no_available_model',
        message: `"${requested}" has no usable target right now (${skipped.map(s => `${s.model}: ${s.reason}`).join('; ') || 'none configured'})`,
        param: 'model',
      });
    }
    return { requested, alias, candidates, skipped };
  }

  /** What GET /v1/models shows this key: every model and alias it may use and, if it is local-only, can reach. */
  list(key: ApiKeyRecord, opts: { localOnly: boolean }): ListedModel[] {
    const providers = new Map(this.providers.list().map(p => [p.id, p]));
    const out: ListedModel[] = [];

    for (const alias of this.aliases.list()) {
      if (!alias.enabled || !allowedBy(key.allowedModels, alias.name)) continue;
      const skipped: Resolution['skipped'] = [];
      let cands = this.candidatesFor(alias.targets, providers, skipped);
      if (opts.localOnly) cands = cands.filter(c => c.model.locality === 'local');
      const primary = cands[0];
      if (!primary) continue;
      const ctxs = cands.map(c => c.model.contextLength).filter((n): n is number => n !== null);
      out.push({
        id: alias.name,
        type: 'alias',
        providerId: null,
        name: alias.name,
        description: alias.description || primary.model.description,
        kind: primary.model.kind,
        tags: [...new Set([...alias.tags, ...(alias.tags.length ? [] : primary.model.tags)])],
        // the answer must fit whichever target ends up serving it
        contextLength: ctxs.length === cands.length && ctxs.length ? Math.min(...ctxs) : null,
        supports: commonSupports(cands.map(c => c.model.supports)),
        locality: cands.every(c => c.model.locality === 'local') ? 'local' : 'cloud',
        targets: cands.map(c => c.model.id),
        primary,
      });
    }

    for (const model of this.models.list()) {
      const provider = providers.get(model.providerId);
      if (!provider || !provider.enabled || !model.enabled) continue;
      if (!model.present && model.source === 'synced') continue;
      if (!allowedBy(key.allowedModels, model.id)) continue;
      if (opts.localOnly && model.locality !== 'local') continue;
      out.push({
        id: model.id,
        type: 'model',
        providerId: provider.id,
        name: model.name,
        description: model.description,
        kind: model.kind,
        tags: model.tags,
        contextLength: model.contextLength,
        supports: model.supports,
        locality: model.locality,
        primary: { model, provider },
      });
    }
    return out;
  }
}

/** Capabilities every target has; unknown (null) if any target does not say. */
function commonSupports(lists: Array<string[] | null>): string[] | null {
  if (!lists.length || lists.some(l => l === null)) return null;
  const [first, ...rest] = lists as string[][];
  return first!.filter(s => rest.every(l => l.includes(s)));
}
