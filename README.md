# Kleis

OpenCode-first OAuth account proxy for coding agents.

Kleis centralizes OAuth accounts for Copilot, Codex, and Claude behind a single
Cloudflare Worker, then exposes API-keyed proxy endpoints plus models.dev-style
discovery so clients can use one base URL.

> [!NOTE]
> "Kleis" is named from the idea of a key that can unlock many paths with one
> handle.

## Why Kleis

If you use multiple coding agents and multiple machines, OAuth setup is usually
the painful part. Kleis is a small control plane that keeps account auth and
refresh in one place and lets clients authenticate with scoped API keys.

## What It Includes

- Provider adapters for Copilot, Codex, and Claude OAuth/refresh flows
- Admin API + minimal admin UI for account and key operations
- OpenCode-compatible `GET /api.json` model discovery
- Provider-specific proxy routes (instead of one generic `/v1`)
- Per-API-key usage analytics (non-blocking ingest on proxy path)
- Basic brute-force protection for admin and API-key auth middleware

## Stack

- Cloudflare Workers + Hono
- D1 + Drizzle ORM
- Zod request validation
- Typed provider metadata/adapters

## API Surface

### Public Routes

- `GET /` service status
- `GET /healthz` health probe
- `GET /api.json` models.dev-compatible registry for clients
- `POST /openai/v1/responses` proxied to Codex provider adapter
- `POST /anthropic/v1/messages` proxied to Claude provider adapter
- `POST /copilot/v1/chat/completions` proxied to Copilot
- `POST /copilot/v1/responses` proxied to Copilot

Proxy routes require either:

- `Authorization: Bearer <KLEIS_API_KEY>`, or
- `x-api-key: <KLEIS_API_KEY>`

### Admin Routes

All admin routes require `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /admin/accounts`
- `POST /admin/accounts/:id/primary`
- `POST /admin/accounts/:id/refresh`
- `POST /admin/accounts/:provider/oauth/start`
- `POST /admin/accounts/:provider/oauth/complete`
- `POST /admin/accounts/:provider/import`
- `GET /admin/keys`
- `GET /admin/keys/usage?windowMs=<ms>`
- `POST /admin/keys`
- `POST /admin/keys/:id/revoke`

### Admin UI

- `GET /admin/index.html`

The UI is intentionally minimal and talks to the admin API directly.

## Quick Start (Local)

1) Install dependencies:

```txt
bun install
```

2) Set your admin token for local dev (Wrangler loads `.dev.vars`):

```txt
ADMIN_TOKEN=replace-with-a-long-random-token
```

3) Apply local migrations:

```txt
bun run db:migrate:local
```

4) Start the worker:

```txt
bun run dev
```

5) Open `http://127.0.0.1:8787/admin/index.html` and log in with
`ADMIN_TOKEN`.

## OpenCode Setup

After creating an API key in the admin UI:

```txt
OPENCODE_MODELS_URL=https://your-kleis-domain
KLEIS_API_KEY=your-issued-key
```

OpenCode will consume `GET /api.json` and use provider-specific endpoints from
that registry.

## Model Prefix Behavior

Kleis accepts plain model ids and provider-prefixed model ids. For route-aware
rewriting, these prefixes are normalized before forwarding:

- OpenAI route: `openai/<model>` or `codex/<model>`
- Anthropic route: `anthropic/<model>` or `claude/<model>`
- Copilot route: `github-copilot/<model>` or `copilot/<model>`

## Analytics Notes

Per-key analytics are written as minute buckets in D1 and include request
counts, status-class counters, average/max latency, last-seen timestamp, and
provider breakdown. Ingest is non-blocking relative to proxy response flow.

## Core Commands

```txt
bun run typecheck
bun run lint
bun run test
bun run db:generate
bun run db:migrate:local
bun run db:migrate:remote
bun run deploy
```
