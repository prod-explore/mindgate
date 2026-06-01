import { config } from './config.js'

/**
 * Router modeli — mapuje profile semantyczne na nazwy Ollama.
 */

/**
 * Rozwiązuje profil modelu na konfigurację Ollama.
 * Zwraca { ollamaModel, maxTokens, isPipeline, pipelineSteps }
 */
export function resolveModel(modelName) {
  // Pipeline: "pipeline:reasoning+flash"
  if (modelName.startsWith('pipeline:')) {
    const pipelineName = modelName.slice('pipeline:'.length)
    const pipeline = config.pipelines[pipelineName]

    if (!pipeline) {
      return { error: `Nieznany pipeline: "${pipelineName}"` }
    }

    // Rozwiąż każdy krok pipeline
    const steps = pipeline.steps.map(step => {
      const modelCfg = config.models[step.model]
      if (!modelCfg) {
        return { error: `Pipeline step "${step.model}" — nieznany model` }
      }
      return {
        profile: step.model,
        ollamaModel: modelCfg.ollama,
        maxTokens: modelCfg.max_tokens,
        role: step.role
      }
    })

    // Sprawdź błędy w krokach
    const stepError = steps.find(s => s.error)
    if (stepError) {
      return { error: stepError.error }
    }

    return {
      isPipeline: true,
      pipelineSteps: steps
    }
  }

  // Pojedynczy model
  const modelCfg = config.models[modelName]
  if (!modelCfg) {
    return { error: `Nieznany model: "${modelName}"` }
  }

  return {
    isPipeline: false,
    profile: modelName,
    ollamaModel: modelCfg.ollama,
    maxTokens: modelCfg.max_tokens
  }
}

/**
 * Zwraca listę wszystkich profili (do /health).
 */
export function getAvailableProfiles() {
  return Object.keys(config.models)
}
