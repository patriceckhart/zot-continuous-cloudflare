import { ConfigError, controlToken } from './config.js'
import { ConflictError, type Operations } from './control.js'

type Env = Record<string, string | undefined>

// Compare SHA-256 digests so the comparison time does not depend on the
// position of the first differing byte or on the token length.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [x, y] = await Promise.all([a, b].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))))
  const left = new Uint8Array(x), right = new Uint8Array(y)
  let diff = 0
  for (let index = 0; index < left.length; index++) diff |= left[index] ^ right[index]
  return diff === 0
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

async function smallBody(request: Request): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > 1024) {
        await reader.cancel()
        throw new ConfigError('Request body is too large')
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

export function createHandler(operations: Operations, env: Env) {
  return async (request: Request): Promise<Response> => {
    try {
      const expected = controlToken(env)
      const supplied = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1] || ''
      if (!(await sameSecret(supplied, expected))) return json({ error: 'Unauthorized' }, 401)
      if (request.method === 'GET') return json(await operations.status(env))
      if (!['POST', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
      const body = await smallBody(request)
      if (request.method === 'POST') {
        if (body.trim()) return json({ error: 'POST does not accept a request body. Configure the deployment environment instead.' }, 400)
        return json(await operations.start(env))
      }
      let confirmation: unknown
      try { confirmation = JSON.parse(body) } catch { return json({ error: 'DELETE requires a JSON confirmation body' }, 400) }
      if (!confirmation || typeof confirmation !== 'object' || (confirmation as Record<string, unknown>).discardWorkspace !== true) {
        return json({ error: 'Set discardWorkspace to true. Unpushed work and refreshed OAuth tokens will be lost.' }, 400)
      }
      return json(await operations.stop(env))
    } catch (error) {
      if (error instanceof ConfigError) return json({ error: error.message }, 400)
      if (error instanceof ConflictError) return json({ error: error.message }, 409)
      // Runtime errors can contain credential-bearing values. Never return or log them.
      return json({ error: 'Container operation failed. Inspect the Cloudflare dashboard and verify configuration.' }, 502)
    }
  }
}
