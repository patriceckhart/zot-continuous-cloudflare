import { ConfigError, instanceName, runtimeConfig, sleepAfter, type RuntimeConfig } from './config.js'

export const WEB_PORT = 7787
export const WEBSOCKET_PATH = '/ws'

export class ConflictError extends Error {}

type Env = Record<string, string | undefined>

export interface HostState {
  status: string
  ready: boolean
}

// Narrow view of the Durable Object stub so the control flow is testable
// without the Workers runtime.
export interface HostStub {
  hostState(): Promise<HostState>
  startHost(config: RuntimeConfig, sleepAfterSeconds: number): Promise<HostState>
  stopHost(): Promise<{ graceful: boolean }>
}

export interface Operations {
  start: (env: Env) => Promise<unknown>
  status: (env: Env) => Promise<unknown>
  stop: (env: Env) => Promise<unknown>
}

function describe(name: string, state: HostState, origin: string) {
  return {
    name,
    status: state.status,
    ready: state.ready,
    websocketUrl: state.ready ? origin.replace(/^http/, 'ws') + WEBSOCKET_PATH : null,
  }
}

export function createOperations(stub: (name: string) => HostStub, origin: string): Operations {
  return {
    async status(env) {
      const name = instanceName(env)
      return describe(name, await stub(name).hostState(), origin)
    },
    async start(env) {
      const config = runtimeConfig(env)
      const seconds = sleepAfter(env)
      const name = instanceName(env)
      const host = stub(name)
      const current = await host.hostState()
      if (current.ready) return describe(name, current, origin)
      if (current.status === 'running' || current.status === 'stopping') {
        throw new ConflictError('A container is running but not ready. Stop it explicitly before starting again.')
      }
      let state: HostState
      try {
        state = await host.startHost(config, seconds)
      } catch {
        // Startup errors can echo environment values. Never return them.
        try { await host.stopHost() } catch {}
        throw new Error('Container startup failed')
      }
      if (!state.ready) throw new ConflictError('Container started but is not ready. Check configuration, database access, and provider credentials.')
      return describe(name, state, origin)
    },
    async stop(env) {
      const name = instanceName(env)
      const result = await stub(name).stopHost()
      return { name, status: 'stopped', graceful: result.graceful }
    },
  }
}

export { ConfigError }
