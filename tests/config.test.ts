import { describe, expect, test } from 'bun:test'
import { controlToken, instanceName, parseOAuth, runtimeConfig, sleepAfter } from '../src/config.js'
import { credentials, zotArgs } from '../container/runner.mjs'

function valid() {
  return {
    CONTROL_API_TOKEN: 'control-'.repeat(6),
    ZOT_HOST_TOKEN: 'host-'.repeat(8),
    ZOT_CONTINUOUS_POSTGRES_DSN: 'postgresql://user:synthetic-password@db.example/zot?sslmode=verify-full',
    ZOT_WEB_ORIGIN: 'https://web.zot.sh',
    ZOT_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_API_KEY: 'synthetic-api-key',
  }
}
const oauth = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expiry: '2099-01-01T00:00:00Z' }

describe('configuration', () => {
  test('uses read-only tools and no implicit durability override', () => {
    const config = runtimeConfig(valid())
    expect(config.tools).toBe('read,glob')
    expect(config.trustRemoteDurability).toBe(false)
    expect(config.allowGitPush).toBe(false)
    expect(config.gitToken).toBeUndefined()
  })

  test.each([
    ['CONTROL_API_TOKEN', 'short'],
    ['ZOT_HOST_TOKEN', 'space '.repeat(10)],
    ['ZOT_WEB_ORIGIN', 'https://web.zot.sh/path'],
    ['ZOT_WEB_ORIGIN', 'http://web.zot.sh'],
    ['ZOT_CONTINUOUS_POSTGRES_DSN', 'postgresql://db.example/zot'],
    ['ZOT_CONTINUOUS_POSTGRES_DSN', 'not-a-url-with-a-secret'],
    ['ZOT_PROVIDER', 'shell'],
    ['ZOT_MODEL', '--bad'],
    ['ZOT_STORE_NAME', '../main'],
    ['GIT_REPOSITORY', 'https://github.com/owner/repo'],
    ['GIT_REPOSITORY', 'owner/repo\nmalicious'],
    ['GIT_BRANCH', '--upload-pack=evil'],
    ['GIT_BRANCH', 'main..evil'],
    ['GIT_BRANCH', 'main.lock'],
    ['GIT_ALLOW_PUSH', 'true'],
    ['ZOT_POSTGRES_TRUST_REMOTE_DURABILITY', 'yes'],
    ['ZOT_TOOLS', 'read bash'],
  ])('rejects invalid %s safely', (name, value) => {
    expect(() => runtimeConfig({ ...valid(), [name]: value })).toThrow()
  })

  test('does not echo a malformed DSN or credential JSON in errors', () => {
    for (const env of [
      { ...valid(), ZOT_CONTINUOUS_POSTGRES_DSN: 'sensitive-value' },
      { ...valid(), ANTHROPIC_API_KEY: '', CLAUDE_OAUTH_JSON: 'sensitive-value' },
    ]) {
      try { runtimeConfig(env) } catch (error) {
        expect(String(error)).not.toContain('sensitive-value')
      }
    }
  })

  test('separates management and host credentials', () => {
    const env = valid()
    expect(() => runtimeConfig({ ...env, ZOT_HOST_TOKEN: env.CONTROL_API_TOKEN })).toThrow('must differ')
  })

  test('maps Claude and Codex subscriptions to zot credential storage', () => {
    const claude = runtimeConfig({ ...valid(), ANTHROPIC_API_KEY: '', CLAUDE_OAUTH_JSON: JSON.stringify(oauth) })
    expect(credentials(claude)).toEqual({ anthropic: { oauth } })
    const codexToken = { ...oauth, account_id: 'synthetic-account' }
    const codex = runtimeConfig({ ...valid(), ZOT_PROVIDER: 'openai-codex', CODEX_OAUTH_JSON: JSON.stringify(codexToken) })
    expect(credentials(codex)).toEqual({ openai: { oauth: codexToken } })
    expect(zotArgs(codex)).toContain('openai-codex')
    expect(JSON.stringify(codex)).not.toContain('synthetic-api-key')
  })

  test('maps API keys and rejects mixed Claude authentication', () => {
    expect(credentials(runtimeConfig(valid()))).toEqual({ anthropic: { api_key: 'synthetic-api-key' } })
    expect(() => runtimeConfig({ ...valid(), CLAUDE_OAUTH_JSON: JSON.stringify(oauth) })).toThrow('not both')
    expect(credentials(runtimeConfig({ ...valid(), ZOT_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-openai' }))).toEqual({ openai: { api_key: 'synthetic-openai' } })
  })

  test('validates subscription expiry, structure, and Codex account identity', () => {
    for (const token of [[], {}, { ...oauth, expiry: 'tomorrow' }, { ...oauth, expiry: '2000-01-01T00:00:00Z', refresh_token: '' }, { ...oauth, unknown: 'field' }, { ...oauth, access_token: '\nsecret' }]) {
      expect(() => parseOAuth(JSON.stringify(token), 'TEST_OAUTH', false)).toThrow()
    }
    expect(() => parseOAuth(JSON.stringify(oauth), 'CODEX_OAUTH_JSON', true)).toThrow('account_id')
    expect(parseOAuth(JSON.stringify({ ...oauth, expiry: '2000-01-01T00:00:00Z' }), 'TEST_OAUTH', false)).toEqual({ ...oauth, expiry: '2000-01-01T00:00:00Z' })
  })

  test('accepts only bounded idle durations and valid instance names', () => {
    expect(sleepAfter({})).toBe(1800)
    expect(instanceName({})).toBe('zot-continuous')
    for (const value of ['0', '-1', 'abc', '86401', '60.5']) expect(() => sleepAfter({ ZOT_SLEEP_AFTER_SECONDS: value })).toThrow()
    expect(() => instanceName({ ZOT_INSTANCE_NAME: '../bad' })).toThrow()
    expect(() => controlToken({})).toThrow()
  })

  test('retains Git credentials only when configured', () => {
    const config = runtimeConfig({ ...valid(), GIT_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'synthetic-git', GIT_ALLOW_PUSH: 'true' })
    expect(config.allowGitPush).toBe(true)
    expect(config.gitToken).toBe('synthetic-git')
  })
})

test('runner keeps secrets out of arguments and disables repository extensions', () => {
  const config = runtimeConfig({ ...valid(), ZOT_POSTGRES_TRUST_REMOTE_DURABILITY: 'true' })
  const args = zotArgs(config)
  expect(args).toContain('--postgres-trust-remote-durability')
  expect(args).toContain('--no-ext')
  expect(args).toContain('--no-skills')
  expect(args).toContain('--token-file')
  expect(args.join(' ')).not.toContain(config.dsn)
  expect(args.join(' ')).not.toContain(config.hostToken)
  expect(args.join(' ')).not.toContain(config.apiKey!)
  expect(zotArgs(runtimeConfig(valid()))).not.toContain('--postgres-trust-remote-durability')
})
