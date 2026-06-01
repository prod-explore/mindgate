import { config } from './config.js'

/**
 * Proxy — przekazuje żądania do agenta.
 * Obsługuje tryb streaming (SSE) i non-streaming.
 */

/**
 * Proxy non-streaming — wysyła żądanie, czeka na pełną odpowiedź, zwraca JSON.
 */
export async function proxyToAgent(req, model) {
  const body = {
    ...req.body,
    model,
    stream: false
  }

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
  if (config.agent.timeout_ms > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.agent.timeout_ms)
  }

  const res = await fetch(`${config.agent.url}/v1/chat/completions`, fetchOpts)

  if (!res.ok) {
    const errorBody = await res.text()
    const error = new Error(`Agent zwrócił ${res.status}`)
    error.statusCode = res.status
    error.body = errorBody
    throw error
  }

  return await res.json()
}

/**
 * Proxy streaming — SSE passthrough z agenta do klienta.
 * Klient dostaje Server-Sent Events w formacie OpenAI.
 */
export async function proxyStreamToAgent(req, reply, model) {
  const body = {
    ...req.body,
    model,
    stream: true
  }

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
  if (config.agent.timeout_ms > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.agent.timeout_ms)
  }

  const res = await fetch(`${config.agent.url}/v1/chat/completions`, fetchOpts)

  if (!res.ok) {
    const errorBody = await res.text()
    reply.code(res.status).send({
      error: {
        message: `Agent error: ${errorBody}`,
        type: 'server_error',
        code: 'agent_error'
      }
    })
    return
  }

  // Streaming — ustawiamy nagłówki SSE i przekazujemy chunki
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked'
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      reply.raw.write(chunk)
    }
  } catch (err) {
    req.log.error({ err: err.message }, 'Błąd podczas streamingu')
  } finally {
    reply.raw.end()
  }
}
