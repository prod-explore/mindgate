import { chatCompletion } from './ollama.js'
import pino from 'pino'

const log = pino({ name: 'pipeline' })

/**
 * Pipeline — multi-model przetwarzanie.
 *
 * Krok 1: Wyślij oryginalne messages do modelu X
 * Krok 2: Odpowiedź X → dodaj do historii → wyślij do Y z system promptem
 * Klient dostaje jedną odpowiedź (ostatni krok).
 */

/**
 * Wykonuje pipeline (non-streaming).
 * Pipeline zawsze działa non-streaming — streaming jest tylko na ostatnim kroku.
 */
export async function executePipeline(pipelineSteps, originalMessages, options = {}) {
  let messages = [...originalMessages]
  let lastResponse = null

  for (let i = 0; i < pipelineSteps.length; i++) {
    const step = pipelineSteps[i]
    const isLast = i === pipelineSteps.length - 1

    log.info({
      step: i + 1,
      total: pipelineSteps.length,
      model: step.profile,
      ollama: step.ollamaModel,
      role: step.role
    }, 'Pipeline krok')

    // Dla kroków 2+ dodaj system prompt definiujący rolę
    if (i > 0 && step.role) {
      messages = [
        ...messages,
        {
          role: 'system',
          content: step.role
        }
      ]
    }

    // Wykonaj krok
    lastResponse = await chatCompletion(step.ollamaModel, messages, {
      max_tokens: step.maxTokens,
      ...options
    })

    // Dodaj odpowiedź do historii (dla kolejnych kroków)
    if (!isLast && lastResponse.choices?.[0]?.message) {
      messages = [
        ...messages,
        lastResponse.choices[0].message
      ]
    }
  }

  log.info({ steps: pipelineSteps.length }, 'Pipeline zakończony')
  return lastResponse
}
