import { config } from './config.js'

/**
 * Proxy — przekazuje żądania do agenta.
 * Obsługuje tryb streaming (SSE) i non-streaming.
 *
 * Przy nagłym odcięciu zasilania maszyny:
 * - fetch rzuci błąd sieciowy (ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET)
 * - streaming: klient dostanie SSE error event zanim strumień się zamknie
 * - non-streaming: klient dostanie 502 z informacją o utracie połączenia
 */

/**
 * Sprawdza czy błąd jest błędem sieciowym (agent nieosiągalny / padł).
 */
function isConnectionError(err) {
  const msg = err?.message || ''
  const code = err?.cause?.code || err?.code || ''
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up') ||
    err?.name === 'AbortError'
  )
}

/**
 * Tworzy standardowy obiekt błędu dla klienta.
 */
function makeAgentDownError(err) {
  const error = new Error('Maszyna obliczeniowa straciła połączenie — możliwa utrata zasilania lub restart.')
  error.statusCode = 502
  error.body = JSON.stringify({
    error: {
      message: 'Maszyna obliczeniowa straciła połączenie. Spróbuj ponownie — system automatycznie wybudzi maszynę jeśli to konieczne.',
      type: 'server_error',
      code: 'agent_connection_lost',
      details: err?.message
    }
  })
  error.isConnectionLost = true
  return error
}

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
    headers: { 
      'Content-Type': 'application/json',
      'X-MindGate-Secret': config.agent.secret
    },
    body: JSON.stringify(body)
  }
  if (config.agent.timeout_ms > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.agent.timeout_ms)
  }

  let res
  try {
    res = await fetch(`${config.agent.url}/v1/chat/completions`, fetchOpts)
  } catch (err) {
    if (isConnectionError(err)) {
      req.log.warn({ err: err.message }, 'Utracono połączenie z agentem (możliwa utrata zasilania)')
      throw makeAgentDownError(err)
    }
    throw err
  }

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
 *
 * Przy utracie połączenia w środku streamingu:
 * - wysyłamy SSE error event do klienta
 * - zamykamy strumień z informacją o błędzie
 */
export async function proxyStreamToAgent(req, reply, model) {
  const body = {
    ...req.body,
    model,
    stream: true
  }

  const fetchOpts = {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-MindGate-Secret': config.agent.secret
    },
    body: JSON.stringify(body)
  }
  if (config.agent.timeout_ms > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.agent.timeout_ms)
  }

  let res
  try {
    res = await fetch(`${config.agent.url}/v1/chat/completions`, fetchOpts)
  } catch (err) {
    if (isConnectionError(err)) {
      req.log.warn({ err: err.message }, 'Utracono połączenie z agentem przed rozpoczęciem streamingu')
      throw makeAgentDownError(err)
    }
    throw err
  }

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
    req.log.error({ err: err.message }, 'Połączenie z agentem przerwane w trakcie streamingu')

    // Wyślij SSE error event do klienta (OpenAI-compatible format)
    const errorEvent = JSON.stringify({
      error: {
        message: 'Połączenie z maszyną obliczeniową zostało przerwane — możliwa utrata zasilania.',
        type: 'server_error',
        code: 'agent_connection_lost'
      }
    })
    try {
      reply.raw.write(`data: ${errorEvent}\n\n`)
      reply.raw.write('data: [DONE]\n\n')
    } catch {
      // Klient mógł się już rozłączyć
    }

    if (isConnectionError(err)) {
      throw makeAgentDownError(err)
    }
    throw err
  } finally {
    reply.raw.end()
  }
}
