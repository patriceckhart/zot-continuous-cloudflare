import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const ROOT = '/tmp/zot-host'
export const ZOT_BINARY = '/usr/local/bin/zot'
// zot serves the authenticated WebSocket endpoint directly. The Worker
// forwards only same-origin-checked upgrades to this port.
export const WEB_PORT = 7787

/** @param {import('../src/config.js').RuntimeConfig} config */
export function zotArgs(config, root = ROOT) {
  const args = [
    'continuous', 'serve', '--backend', 'postgres',
    '--store-name', config.storeName, '--state-dir', `${root}/state`,
    '--cwd', `${root}/workspace`, '--provider', config.provider,
    '--model', config.model, '--tools', config.tools,
    '--no-ext', '--no-skills',
    '--token-file', `${root}/tokens`,
    '--web', `0.0.0.0:${WEB_PORT}`, '--web-origin', config.webOrigin,
  ]
  if (config.trustRemoteDurability) args.push('--postgres-trust-remote-durability')
  return args
}

/**
 * @param {import('../src/config.js').RuntimeConfig} config
 * @returns {Record<string, {oauth?: import('../src/config.js').OAuthToken, api_key?: string}>}
 */
export function credentials(config) {
  const provider = config.provider === 'openai-codex' ? 'openai' : config.provider
  return { [provider]: config.oauth ? { oauth: config.oauth } : { api_key: config.apiKey } }
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'ignore', timeout: 90000, killSignal: 'SIGKILL' })
    child.once('error', () => reject(new Error('Bootstrap command failed')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Bootstrap command failed')))
  })
}

export async function main() {
  process.umask(0o077)
  const config = JSON.parse(process.env.ZOT_BOOTSTRAP_CONFIG || '{}')
  delete process.env.ZOT_BOOTSTRAP_CONFIG
  for (const directory of [ROOT, `${ROOT}/home`, `${ROOT}/state`, `${ROOT}/workspace`]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  const askpass = `${ROOT}/git-askpass.mjs`
  await writeFile(askpass, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.toLowerCase().includes("username") ? "x-access-token" : (process.env.ZOT_GIT_TOKEN || ""))\n', { mode: 0o700 })
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, ZOT_GIT_TOKEN: config.gitToken || '' }
  if (config.repository) {
    await run('git', ['check-ref-format', '--branch', config.branch], gitEnv)
    await run('git', ['clone', '--single-branch', '--branch', config.branch, '--', `https://github.com/${config.repository}.git`, `${ROOT}/workspace`], gitEnv)
  }
  await writeFile(`${ROOT}/home/auth.json`, JSON.stringify(credentials(config)), { mode: 0o600 })
  await writeFile(`${ROOT}/tokens`, `${config.hostToken} admin\n`, { mode: 0o600 })
  const env = {
    ...process.env, ZOT_HOME: `${ROOT}/home`,
    ZOT_CONTINUOUS_POSTGRES_DSN: config.dsn,
    GIT_TERMINAL_PROMPT: '0',
  }
  if (config.allowGitPush) Object.assign(env, { GIT_ASKPASS: askpass, ZOT_GIT_TOKEN: config.gitToken })
  const logs = createWriteStream(`${ROOT}/host.log`, { mode: 0o600 })
  const child = spawn(ZOT_BINARY, zotArgs(config), { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logs, { end: false })
  child.stderr.pipe(logs, { end: false })
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(1))
    child.once('exit', code => resolve(code ?? 1))
  })
  let stopping = false
  const stop = () => {
    if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    stopping = true
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    timer.unref()
  }
  logs.on('error', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    process.exitCode = await exited
  } finally {
    stop()
    await exited
    logs.end()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Keep provider, database, and Git errors out of the control API logs.
    console.error('Container startup failed. Inspect /tmp/zot-host/host.log privately if it exists.')
    process.exitCode = 1
  })
}
