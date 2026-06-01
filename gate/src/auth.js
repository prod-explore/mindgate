import { config } from './config.js'

// Indeks kluczy dla szybkiego lookupu
const keyMap = new Map()
for (const entry of config.auth.keys) {
  keyMap.set(entry.key, entry)
}

/**
 * Waliduje Bearer token z nagłówka Authorization.
 * Zwraca obiekt klucza { name, key, default_priority }.
 * Rzuca błąd Fastify jeśli klucz jest niepoprawny.
 */
export function authenticate(req, reply) {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    reply.code(401).send({
      error: {
        message: 'Brak nagłówka Authorization',
        type: 'authentication_error',
        code: 'missing_auth_header'
      }
    })
    return null
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    reply.code(401).send({
      error: {
        message: 'Niepoprawny format — oczekiwany: Authorization: Bearer <klucz>',
        type: 'authentication_error',
        code: 'invalid_auth_format'
      }
    })
    return null
  }

  const token = parts[1]
  const apiKey = keyMap.get(token)

  if (!apiKey) {
    req.log.warn({ token: token.slice(0, 6) + '...' }, 'Nieznany klucz API')
    reply.code(401).send({
      error: {
        message: 'Niepoprawny klucz API',
        type: 'authentication_error',
        code: 'invalid_api_key'
      }
    })
    return null
  }

  req.log.info({ client: apiKey.name }, 'Autoryzacja OK')
  return apiKey
}
