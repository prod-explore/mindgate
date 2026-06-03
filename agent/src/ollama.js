import { config } from './config.js'
import pino from 'pino'

const log = pino({ name: 'ollama' })

/**
 * Klient Ollama — wysyła żądania do /api/chat.
 * Konwertuje OpenAI format ↔ Ollama format.
 */

/**
 * Wysyła żądanie do Ollama (non-streaming).
 * Przyjmuje OpenAI format, zwraca OpenAI format.
 */
export async function chatCompletion(ollamaModel, messages, options = {}) {
  const { max_tokens, temperature, top_p, tools } = options

  const ollamaBody = {
    model: ollamaModel,
    messages: messages.map(convertMessageToOllama),
    stream: false,
    options: {}
  }

  if (max_tokens) ollamaBody.options.num_predict = max_tokens
  if (temperature !== undefined) ollamaBody.options.temperature = temperature
  if (top_p !== undefined) ollamaBody.options.top_p = top_p
  if (tools?.length) ollamaBody.tools = tools

  log.info({ model: ollamaModel, messages: messages.length }, 'Wysyłam do Ollama')

  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaBody),
    signal: AbortSignal.timeout(config.ollama.request_timeout_ms)
  })

  if (!res.ok) {
    const errText = await res.text()
    log.error({ status: res.status, body: errText }, 'Ollama error')
    throw new OllamaError(`Ollama ${res.status}: ${errText}`, res.status)
  }

  const data = await res.json()
  log.info({
    model: ollamaModel,
    eval_count: data.eval_count,
    eval_duration_ms: data.eval_duration ? Math.round(data.eval_duration / 1e6) : null
  }, 'Ollama odpowiedział')

  return convertToOpenAIFormat(data, ollamaModel)
}

/**
 * Wysyła żądanie do Ollama (streaming).
 * Zwraca ReadableStream z SSE chunks w formacie OpenAI.
 */
export async function chatCompletionStream(ollamaModel, messages, options = {}) {
  const { max_tokens, temperature, top_p, tools } = options

  const ollamaBody = {
    model: ollamaModel,
    messages: messages.map(convertMessageToOllama),
    stream: true,
    options: {}
  }

  if (max_tokens) ollamaBody.options.num_predict = max_tokens
  if (temperature !== undefined) ollamaBody.options.temperature = temperature
  if (top_p !== undefined) ollamaBody.options.top_p = top_p
  if (tools?.length) ollamaBody.tools = tools

  log.info({ model: ollamaModel, messages: messages.length }, 'Streaming z Ollama')

  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaBody),
    signal: AbortSignal.timeout(config.ollama.request_timeout_ms)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new OllamaError(`Ollama ${res.status}: ${errText}`, res.status)
  }

  return res.body
}

/**
 * Konwertuje wiadomość OpenAI → Ollama format.
 */
function convertMessageToOllama(msg) {
  const converted = {
    role: msg.role,
    content: msg.content || ''
  }

  // Tool calls w odpowiedzi asystenta
  if (msg.tool_calls) {
    converted.tool_calls = msg.tool_calls
  }

  // Wynik wywołania narzędzia
  if (msg.role === 'tool') {
    converted.role = 'tool'
    converted.content = msg.content
  }

  return converted
}

/**
 * Konwertuje odpowiedź Ollama → OpenAI /v1/chat/completions format.
 */
function convertToOpenAIFormat(ollamaResponse, modelName) {
  const choice = {
    index: 0,
    message: {
      role: 'assistant',
      content: ollamaResponse.message?.content || ''
    },
    finish_reason: ollamaResponse.done ? 'stop' : 'length'
  }

  // Tool calls
  if (ollamaResponse.message?.tool_calls?.length) {
    choice.message.tool_calls = ollamaResponse.message.tool_calls.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments)
      }
    }))
    choice.finish_reason = 'tool_calls'
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [choice],
    usage: {
      prompt_tokens: ollamaResponse.prompt_eval_count || 0,
      completion_tokens: ollamaResponse.eval_count || 0,
      total_tokens: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
    }
  }
}

/**
 * Konwertuje streaming chunk Ollama → OpenAI SSE format.
 * Parsuje NDJSON z Ollama i emituje SSE data lines.
 */
export function createOpenAIStreamTransformer(modelName) {
  const chatId = `chatcmpl-${Date.now()}`
  let buffer = ''
  let hasToolCalls = false

  return new TransformStream({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // zachowaj niekompletną linię

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line)
          const sseChunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: null
            }]
          }

          if (!data.done && data.message) {
            if (data.message.content) {
              sseChunk.choices[0].delta.content = data.message.content
            }
            if (data.message.tool_calls?.length) {
              hasToolCalls = true
              sseChunk.choices[0].delta.tool_calls = data.message.tool_calls.map((tc, i) => ({
                index: i,
                id: `call_${Date.now()}_${i}`,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments)
                }
              }))
            }
          }

          if (data.done) {
            sseChunk.choices[0].finish_reason = hasToolCalls ? 'tool_calls' : 'stop'
          }

          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(sseChunk)}\n\n`)
          )

          if (data.done) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          }
        } catch {
          // Pomiń niepoprawne JSON linie
        }
      }
    },
    flush(controller) {
      // Przetwórz pozostały bufor
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer)
          if (data.done) {
            const sseChunk = {
              id: chatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop'
              }]
            }
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(sseChunk)}\n\n`)
            )
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          }
        } catch {
          // ignoruj
        }
      }
    }
  })
}

/**
 * Sprawdza czy Ollama jest dostępna.
 */
export async function checkOllamaHealth() {
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Pobiera listę załadowanych modeli z Ollama.
 */
export async function getLoadedModels() {
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map(m => m.name)
  } catch {
    return []
  }
}

/**
 * Custom error class dla błędów Ollama.
 */
class OllamaError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = 'OllamaError'
    this.statusCode = statusCode
  }
}
