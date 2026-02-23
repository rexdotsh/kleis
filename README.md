# Kleis

OpenCode-first OAuth account proxy for coding agents.

Kleis centralizes OAuth accounts for Copilot, Codex, and Claude behind a single
API base URL, then exposes API-keyed proxy endpoints plus models.dev-style model
discovery.

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

## Stack

- Vercel Functions + Hono
- Turso (libSQL) + Drizzle ORM
- Zod request validation
- Typed provider metadata/adapters

## Environment Variables

- `ADMIN_TOKEN` - bearer token required for all `/admin/*` routes
- `TURSO_CONNECTION_URL` - Turso database URL
- `TURSO_AUTH_TOKEN` - Turso database auth token

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

2) Create `.env`:

```txt
ADMIN_TOKEN=replace-with-a-long-random-token
TURSO_CONNECTION_URL=libsql://<your-db>.<region>.turso.io
TURSO_AUTH_TOKEN=<your-turso-token>
```

3) Apply migrations:

```txt
bun run db:migrate
```

4) Start local dev server:

```txt
bun run dev
```

5) Open `http://localhost:3000/admin/index.html` and log in with `ADMIN_TOKEN`.

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

Per-key analytics are written as minute buckets and include request counts,
status-class counters, average/max latency, last-seen timestamp, and provider
breakdown.

## Core Commands

```txt
bun run typecheck
bun run lint
bun run test
bun run db:generate
bun run db:migrate
bun run db:studio
```

## Vercel Deployment Notes

The `build` script runs `db:migrate && bundle`. The bundle step uses `bun build`
to collapse all internal modules into a single `dist/index.js`. Vercel's Hono
builder then picks it up via `outputDirectory` in `vercel.json`.

This pre-bundle step is needed because Vercel's `@vercel/node` esbuild pass
does not resolve extensionless TypeScript imports — a known bug
([vercel/vercel#14910](https://github.com/vercel/vercel/issues/14910)). Without
it, multi-file Hono apps crash with `ERR_MODULE_NOT_FOUND`.

`VERCEL_EXPERIMENTAL_BACKENDS=1` fixes module resolution but completely bypasses
CDN static file serving from `public/`. Pre-bundling gives us both.
