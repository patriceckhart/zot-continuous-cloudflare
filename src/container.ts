import { Container } from '@cloudflare/containers'
import type { RuntimeConfig } from './config.js'
import { WEB_PORT, type HostState } from './control.js'

// One Durable Object instance owns one container. The runtime configuration
// is passed only at start and never persisted in Durable Object storage.
export class ZotContainer extends Container<Env> {
  defaultPort = WEB_PORT
  sleepAfter: string | number = 1800
  enableInternet = true

  async hostState(): Promise<HostState> {
    const state = await this.getState()
    return { status: state.status, ready: state.status === 'healthy' }
  }

  async startHost(config: RuntimeConfig, sleepAfterSeconds: number): Promise<HostState> {
    this.sleepAfter = sleepAfterSeconds
    const current = await this.hostState()
    if (current.ready) return current
    if (current.status === 'running' || current.status === 'stopping') {
      throw new Error('Container exists but is not ready')
    }
    await this.startAndWaitForPorts({
      ports: WEB_PORT,
      startOptions: { envVars: { ZOT_BOOTSTRAP_CONFIG: JSON.stringify(config) } },
      cancellationOptions: { portReadyTimeoutMS: 180000 },
    })
    this.renewActivityTimeout()
    return this.hostState()
  }

  async stopHost(): Promise<{ graceful: boolean }> {
    const state = await this.getState()
    if (state.status === 'stopped' || state.status === 'stopped_with_code') return { graceful: true }
    try {
      await this.stop('SIGTERM')
      return { graceful: true }
    } catch {
      await this.destroy()
      return { graceful: false }
    }
  }

  // Never start a container implicitly from a WebSocket request. Starting
  // needs the runtime configuration, which only the control API supplies.
  async fetch(request: Request): Promise<Response> {
    const state = await this.getState()
    if (state.status !== 'healthy') {
      return new Response('Agent is not running', { status: 409 })
    }
    return super.fetch(request)
  }
}
