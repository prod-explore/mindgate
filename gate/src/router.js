import { config } from './config.js'

const validModels = new Set(config.models)
const validPipelines = new Set(config.pipelines)

/**
 * Wyznacza docelowy model z żądania.
 * Priorytet: X-MindGate-Model nagłówek > body.model
 * Zwraca string (np. "reasoning" lub "pipeline:reasoning+flash")
 */
export function resolveModel(req, reply) {
  const headerModel = req.headers['x-mindgate-model']
  const bodyModel = req.body?.model

  const model = headerModel || bodyModel

  if (!model) {
    reply.code(400).send({
      error: {
        message: 'Brak modelu — podaj w polu "model" lub nagłówku X-MindGate-Model',
        type: 'invalid_request_error',
        code: 'missing_model'
      }
    })
    return null
  }

  // Sprawdź pipeline format
  if (model.startsWith('pipeline:')) {
    const pipelineName = model.slice('pipeline:'.length)
    if (!validPipelines.has(pipelineName)) {
      reply.code(400).send({
        error: {
          message: `Nieznany pipeline: "${pipelineName}". Dostępne: ${[...validPipelines].join(', ')}`,
          type: 'invalid_request_error',
          code: 'unknown_pipeline'
        }
      })
      return null
    }
    return model
  }

  // Sprawdź pojedynczy model
  if (!validModels.has(model)) {
    reply.code(400).send({
      error: {
        message: `Nieznany model: "${model}". Dostępne: ${[...validModels].join(', ')}`,
        type: 'invalid_request_error',
        code: 'unknown_model'
      }
    })
    return null
  }

  return model
}

/**
 * Zwraca listę modeli w formacie OpenAI /v1/models
 */
export function getModelList() {
  const models = config.models.map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'mindgate'
  }))

  const pipelines = config.pipelines.map(p => ({
    id: `pipeline:${p}`,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'mindgate'
  }))

  return {
    object: 'list',
    data: [...models, ...pipelines]
  }
}
