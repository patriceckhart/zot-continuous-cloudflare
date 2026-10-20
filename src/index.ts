import { getContainer } from '@cloudflare/containers'
import { instanceName } from './config.js'
import { createOperations, WEBSOCKET_PATH, type HostStub } from './control.js'
import { createHandler } from './handler.js'

export { ZotContainer } from './container.js'

type Vars = Record<string, string | undefined>

// Origin and upgrade are checked here as well as in zot so that rejected
// browsers never reach or renew the container. zot still authenticates
// every WebSocket with ZOT_HOST_TOKEN.
export function acceptsWebSocket(request: Request, origin: string | undefined): boolean {
  return request.method === 'GET'
    && request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    && !!origin && request.headers.get('origin') === origin
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const vars = env as unknown as Vars
    const stub = (name: string) => getContainer(env.ZOT_CONTAINER, name) as unknown as HostStub
    if (url.pathname === '/api') {
      return createHandler(createOperations(stub, url.origin), vars)(request)
    }
    if (url.pathname === WEBSOCKET_PATH) {
      if (!acceptsWebSocket(request, vars.ZOT_WEB_ORIGIN)) return new Response('Forbidden', { status: 403 })
      let name: string
      try { name = instanceName(vars) } catch { return new Response('Invalid configuration', { status: 500 }) }
      return getContainer(env.ZOT_CONTAINER, name).fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
