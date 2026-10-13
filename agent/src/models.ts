import type { LoadedModel, RuntimeModel } from './runtime.js';

/**
 * The model list the hub reads (GET /v1/models). It follows the OpenAI format with the extra fields OpenRouter made
 * common (`context_length`, `supported_parameters`, `architecture`) plus `kind`, `tags` and `locality`, which the hub
 * understands. This is why the hub needs no special code to learn what a node can do.
 */
export function toOpenAiEntry(m: RuntimeModel, contextCap: number | null, runtimeName: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: m.id,
    object: 'model',
    created: m.modifiedAt ? Math.floor(Date.parse(m.modifiedAt) / 1000) || 0 : 0,
    owned_by: runtimeName,
    kind: m.kind,
    locality: 'local',
    tags: m.tags,
  };
  if (m.contextLength) entry['context_length'] = contextCap ? Math.min(m.contextLength, contextCap) : m.contextLength;
  else if (contextCap) entry['context_length'] = contextCap;

  // Only when the runtime told us what the model can do. Silence is not "cannot".
  if (m.capabilities) {
    const caps = new Set(m.capabilities);
    const params: string[] = [];
    if (caps.has('tools')) params.push('tools');
    if (caps.has('thinking')) params.push('reasoning');
    entry['supported_parameters'] = params;
    entry['architecture'] = {
      input_modalities: caps.has('vision') ? ['text', 'image'] : ['text'],
      output_modalities: [m.kind === 'embedding' ? 'embeddings' : 'text'],
    };
  }
  return entry;
}

/** A model for the panel and for /node/models: everything the agent knows, in one object. */
export function toNodeModel(m: RuntimeModel, loaded: LoadedModel[]): Record<string, unknown> {
  const l = loaded.find(x => x.id === m.id);
  return {
    id: m.id,
    kind: m.kind,
    size_bytes: m.sizeBytes,
    digest: m.digest,
    modified_at: m.modifiedAt,
    family: m.family,
    parameter_size: m.parameterSize,
    quantization: m.quantization,
    context_length: m.contextLength,
    capabilities: m.capabilities,
    tags: m.tags,
    loaded: l ? { vram_bytes: l.vramBytes, size_bytes: l.sizeBytes, expires_at: l.expiresAt } : null,
  };
}
