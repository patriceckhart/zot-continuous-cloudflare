# zot continuous on Cloudflare

Run your own [zot](https://zot.sh) agent in the cloud and chat with it from [web.zot.sh](https://web.zot.sh).

The agent runs in a [Cloudflare Container](https://developers.cloudflare.com/containers/) controlled by a Worker and a Durable Object. Your conversations are stored in PostgreSQL (for example [Neon](https://neon.tech)), so they survive when the container stops.

## What you need

- A Cloudflare account on the Workers Paid plan (required for Containers)
- Docker running locally (Wrangler builds the container image on deploy)
- [Bun](https://bun.sh)
- A PostgreSQL database, for example a free Neon project
- An Anthropic or OpenAI API key, or an existing Claude or ChatGPT subscription login

## Setup

### 1. Install and log in

```sh
bun install
bunx wrangler login
```

### 2. Add secrets

Generate two different secrets:

```sh
openssl rand -hex 32
```

Store them and the other secrets in Cloudflare:

```sh
bunx wrangler secret put CONTROL_API_TOKEN
bunx wrangler secret put ZOT_HOST_TOKEN
bunx wrangler secret put ZOT_CONTINUOUS_POSTGRES_DSN
bunx wrangler secret put ANTHROPIC_API_KEY   # or OPENAI_API_KEY
```

| Secret | Value |
| --- | --- |
| `CONTROL_API_TOKEN` | Random secret, at least 32 characters. Used to start and stop the agent. |
| `ZOT_HOST_TOKEN` | A different random secret, at least 32 characters. Used to log in from web.zot.sh. |
| `ZOT_CONTINUOUS_POSTGRES_DSN` | Your database URL, ending with `?sslmode=verify-full` or `?sslmode=require` |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Your API key for the selected provider |

### 3. Adjust settings

Non-secret settings are in `vars` in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZOT_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `openai-codex` |
| `ZOT_MODEL` | `claude-sonnet-4-6` | Model ID |
| `ZOT_WEB_ORIGIN` | `https://web.zot.sh` | Only this browser origin may connect |
| `ZOT_TOOLS` | `read,glob` | Tools the agent may use |
| `ZOT_POSTGRES_TRUST_REMOTE_DURABILITY` | `false` | Set `true` when using Neon |
| `ZOT_STORE_NAME` | `main` | Name of the conversation store in the database |
| `ZOT_INSTANCE_NAME` | `zot-continuous` | Name of the Durable Object owning the container |
| `ZOT_SLEEP_AFTER_SECONDS` | `1800` | Stop after this many seconds without traffic, 60 to 86400 |
| `GIT_BRANCH` | `main` | Branch to clone when `GIT_REPOSITORY` is set |
| `GIT_ALLOW_PUSH` | `false` | Keep Git credentials available to the agent |

### 4. Deploy

```sh
bun run deploy
```

The first deploy builds and uploads the image. It can take a few minutes until the container is available.

### 5. Start the agent

```sh
curl -X POST https://zot-continuous.YOUR-SUBDOMAIN.workers.dev/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN"
```

Starting takes up to a minute. The response contains a `websocketUrl`.

### 6. Connect

Open [web.zot.sh](https://web.zot.sh), enter the `websocketUrl` and your `ZOT_HOST_TOKEN`. Done.

## Everyday use

**Check status**

```sh
curl https://zot-continuous.YOUR-SUBDOMAIN.workers.dev/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN"
```

**Stop the agent**

```sh
curl -X DELETE https://zot-continuous.YOUR-SUBDOMAIN.workers.dev/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"discardWorkspace":true}'
```

Your conversations stay in the database. Files in the container are deleted. Start again with step 5.

The container also stops after `ZOT_SLEEP_AFTER_SECONDS` without WebSocket traffic. It is never started implicitly by a browser connection, only by `POST /api`.

## Optional settings

### Use a Claude or ChatGPT subscription instead of an API key

Do not set an API key for the provider. Set one of these secrets instead:

```sh
# Claude subscription (ZOT_PROVIDER=anthropic)
bunx wrangler secret put CLAUDE_OAUTH_JSON

# ChatGPT / Codex subscription (ZOT_PROVIDER=openai-codex)
bunx wrangler secret put CODEX_OAUTH_JSON
```

The value is the `oauth` object from your local zot `auth.json` for that provider, not the whole file, for example `{"access_token":"...","refresh_token":"...","expiry":"2026-12-01T00:00:00Z"}`. Codex also needs `account_id`.

**Note:** zot renews these tokens while running, but renewed tokens are lost when the container stops. If the next start fails to log in, log in again locally and update the secret.

> **Note on subscription login.** The OAuth client IDs used are the ones published in Anthropic's Claude Code CLI, OpenAI's Codex CLI, Kimi Code CLI, xAI's device flow, and GitHub Copilot's device-code flow. Reusing them from a third-party tool may be against their terms of service and may be revoked at any time. Use it at your own risk; the API-key flow is the safe default.

### Work on a GitHub repository

```sh
bunx wrangler secret put GIT_REPOSITORY   # owner/repository
bunx wrangler secret put GITHUB_TOKEN
```

The branch from `GIT_BRANCH` is cloned when the agent starts. By default the agent can only read files. To let it edit code and run commands, set in `wrangler.jsonc`:

```jsonc
"ZOT_TOOLS": "read,glob,write,edit,bash",
"GIT_ALLOW_PUSH": "true"
```

**Push your work before stopping.** Unpushed changes are lost with the container.

### Upgrade zot

The zot release is pinned in `container/Dockerfile`. Change `ZOT_VERSION` and `ZOT_ARCHIVE_SHA256` together (the checksum for `zot_<version>_linux_amd64.tar.gz` is in the release's `checksums.txt`), then deploy again.

## How it works

- `POST /api` validates the configuration in the Worker, then asks the `ZotContainer` Durable Object to start the container with the configuration as environment variables.
- `container/runner.mjs` writes credentials to files with mode 0600, optionally clones the repository, then runs `zot continuous serve --backend postgres --web`.
- `GET /ws` is accepted only with the configured `Origin` and forwarded to the container. zot itself checks the origin again and authenticates every connection with `ZOT_HOST_TOKEN`.

## Good to know

- **One agent per deployment.** Do not point two deployments at the same database store.
- **Keep both tokens secret.** `CONTROL_API_TOKEN` controls the container, `ZOT_HOST_TOKEN` gives full access to the agent. If one leaks, replace it with `wrangler secret put`.
- **The agent can see its own secrets.** With `bash` enabled it can read the API key, database URL and GitHub token inside the container. Only use repositories and prompts you trust.
- **Not always on.** The container stops after its idle timeout or when Cloudflare restarts it. Queued work continues the next time you start it.
- **Database connection lost?** The agent stops. Start it again.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `401` | Wrong `CONTROL_API_TOKEN`, or the secret is not set. |
| `400` with a variable name | That variable is missing or invalid. |
| `409` | The container is running but not healthy. Stop it with `DELETE`, then start again. |
| `502` on start | Check database access and provider credentials. The first start after deploy can fail while the image is still rolling out. |
| web.zot.sh does not connect | Check `ZOT_HOST_TOKEN` and that `ZOT_WEB_ORIGIN` is exactly `https://web.zot.sh`. |

## Development

```sh
bun install
bun run check
bun run test
```

Tests run locally only. They do not start containers or call any paid service. Run `bunx wrangler types --env-file .dev.vars.example` after changing `wrangler.jsonc`.

## Links

- [zot](https://zot.sh)
- [zot continuous documentation](https://github.com/patriceckhart/zot/blob/main/docs/continuous.md)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [zot continuous on Vercel](https://github.com/patriceckhart/zot-continuous-vercel)

## License

MIT
