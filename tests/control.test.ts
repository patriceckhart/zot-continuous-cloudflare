import { describe, expect, test } from 'bun:test'
import { ConflictError, createOperations, type HostState, type HostStub } from '../src/control.js'

const env = {
  CONTROL_API_TOKEN: 'synthetic-control-'.repeat(3),
  ZOT_HOST_TOKEN: 'synthetic-host-'.repeat(3),
  ZOT_CONTINUOUS_POSTGRES_DSN: 'postgresql://user:synthetic@db.example/zot?sslmode=verify-full',
  ZOT_WEB_ORIGIN: 'https://web.zot.sh',
  ZOT_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_API_KEY: 'synthetic-key',
}
const origin = 'https://zot.example.workers.dev'

function fake(initial: HostState, startResult: HostState | Error = { status: 'healthy', ready: true }) {
  const calls: string[] = []
  let names: string[] = []
  const host: HostStub = {
    async hostState() { calls.push('state'); return initial },
    async startHost(config, seconds) {
      calls.push(`start:${seconds}:${config.storeName}`)
      if (startResult instanceof Error) throw startResult
      return startResult
    },
    async stopHost() { calls.push('stop'); return { graceful: true } },
  }
  const operations = createOperations(name => { names.push(name); return host }, origin)
  return { calls, operations, names: () => names }
}

describe('container operations', () => {
  test('status reports a websocket URL only when ready', async () => {
    expect(await fake({ status: 'stopped', ready: false }).operations.status(env)).toEqual({ name: 'zot-continuous', status: 'stopped', ready: false, websocketUrl: null })
    expect(await fake({ status: 'healthy', ready: true }).operations.status(env)).toMatchObject({ websocketUrl: 'wss://zot.example.workers.dev/ws' })
  })

  test('start validates configuration before touching the container', async () => {
    const { operations, calls } = fake({ status: 'stopped', ready: false })
    await expect(operations.start({ ...env, ZOT_MODEL: '' })).rejects.toThrow('ZOT_MODEL')
    expect(calls).toEqual([])
  })

  test('start is idempotent and forwards the idle timeout', async () => {
    const ready = fake({ status: 'healthy', ready: true })
    await ready.operations.start(env)
    expect(ready.calls).toEqual(['state'])
    const stopped = fake({ status: 'stopped_with_code', ready: false })
    expect(await stopped.operations.start({ ...env, ZOT_SLEEP_AFTER_SECONDS: '600', ZOT_INSTANCE_NAME: 'agent-1' })).toMatchObject({ ready: true, name: 'agent-1' })
    expect(stopped.calls).toEqual(['state', 'start:600:main'])
    expect(stopped.names()).toEqual(['agent-1'])
  })

  test('refuses to take over a running but unhealthy container', async () => {
    const { operations, calls } = fake({ status: 'running', ready: false })
    await expect(operations.start(env)).rejects.toBeInstanceOf(ConflictError)
    expect(calls).toEqual(['state'])
  })

  test('cleans up and redacts startup failures', async () => {
    const { operations, calls } = fake({ status: 'stopped', ready: false }, new Error('synthetic-key leaked'))
    const error = await operations.start(env).catch(error => error)
    expect(String(error)).not.toContain('synthetic-key')
    expect(calls).toEqual(['state', 'start:1800:main', 'stop'])
  })

  test('stop delegates to the named container', async () => {
    const { operations, calls } = fake({ status: 'healthy', ready: true })
    expect(await operations.stop(env)).toEqual({ name: 'zot-continuous', status: 'stopped', graceful: true })
    expect(calls).toEqual(['stop'])
  })
})
