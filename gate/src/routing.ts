import { HubError, notFound } from './errors.js';
import type { ModelStore } from './store/models.js';
import type { ProviderStore } from './store/providers.js';
import type { ApiKeyRecord, ModelKind, ProviderRecord, ResolvedModel } from './types.js';

export interface Candidate {
  model: ResolvedModel;
  provider: ProviderRecord;
}

export interface Resolution {
  requested: string;
  /** The model that serves the request. */
  candidate: Candidate;
  /** What was left out and why (provider disabled, not local...). */
  skipped: Array<{ model: string; reason: string }>;
}

export interface ResolveOptions {
  /** The request must not reach a model that runs outside the owner's hardware, fallbacks included. */
  localOnly: boolean;
  kind?: ModelKind;
}

export interface ListedModel {
  id: string;
  providerId: string;
  name: string;
  description: string;
  kind: ModelKind;
  tags: string[];
  contextLength: number | null;
  supports: string[] | null;
  locality: 'local' | 'cloud';
  primary: Candidate;
}

/** `*`, an exact model id, or `provider/*`. */
export function allowedBy(patterns: string[] | null, name: string): boolean {
  if (patterns === null) return true;
  return patterns.some(p => p === '*' || p === name || (p.endsWith('/*') && name.startsWith(p.slice(0, -1))));
}

export class Router {
  constructor(
    private readonly models: ModelStore,
    private readonly providers: ProviderStore,
  ) {}

  resolve(name: string, key: ApiKeyRecord, opts: ResolveOptions): Resolution {
    const requested = name.trim();
    const skipped: Resolution['skipped'] = [];
    const notFoundError = () => notFound('model_not_found', `The model "${requested}" does not exist. List the available ones with GET /v1/models.`);

    if (!requested.includes('/') || !this.models.getRecord(requested)) throw notFoundError();
    if (!allowedBy(key.allowedModels, requested)) {
      throw new HubError({ status: 403, code: 'model_not_allowed', message: `The key "${key.name}" is not allowed to use "${requested}"`, param: 'model' });
    }

    const model = this.models.get(requested);
    const provider = model ? this.providers.get(model.providerId) : undefined;
    if (!model) skipped.push({ model: requested, reason: 'unknown_model' });
    else if (!provider || !provider.enabled) skipped.push({ model: requested, reason: 'provider_disabled' });
    else if (!model.enabled) skipped.push({ model: requested, reason: 'model_disabled' });

    if (model && provider && provider.enabled && model.enabled) {
      if (opts.kind && model.kind !== opts.kind) {
        const use = model.kind === 'embedding' ? 'POST /v1/embeddings' : 'an endpoint for that kind of model';
        throw new HubError({ status: 400, code: 'wrong_model_kind', message: `"${requested}" is a ${model.kind} model and cannot be used here; use ${use}`, param: 'model' });
      }
      if (opts.localOnly && model.locality !== 'local') {
        throw new HubError({
          status: 403,
          code: 'local_only_violation',
          message: `"${requested}" does not run locally, and this request is restricted to local models (the key's local_only setting or the X-MindGate-Local-Only header)`,
          param: 'model',
        });
      }
      return { requested, candidate: { model, provider }, skipped };
    }

    throw new HubError({
      status: 503,
      code: 'no_available_model',
      message: `"${requested}" is not usable right now (${skipped.map(s => `${s.model}: ${s.reason}`).join('; ') || 'none configured'})`,
      param: 'model',
    });
  }

  /** What GET /v1/models shows this key: every model it may use and, if it is local-only, can reach. */
  list(key: ApiKeyRecord, opts: { localOnly: boolean }): ListedModel[] {
    const providers = new Map(this.providers.list().map(p => [p.id, p]));
    const out: ListedModel[] = [];
    for (const model of this.models.list()) {
      const provider = providers.get(model.providerId);
      if (!provider || !provider.enabled || !model.enabled) continue;
      if (!model.present && model.source === 'synced') continue;
      if (!allowedBy(key.allowedModels, model.id)) continue;
      if (opts.localOnly && model.locality !== 'local') continue;
      out.push({
        id: model.id,
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
