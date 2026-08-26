# Kleis

Single OAuth account proxy for coding agents. One base URL that stores OAuth credentials centrally, refreshes tokens automatically, and routes requests to Codex and Claude through provider-compatible proxy endpoints.

## Architecture

- **Runtime**: Bun + Hono, self-hosted as a long-running server
- **Database**: Turso (libSQL) via Drizzle ORM
- **Admin UI**: Vanilla HTML/CSS/JS SPA in `public/admin/`
- **Linting**: `bun fix` (Biome-based via Ultracite)
- **Tests**: `bun test`
- **Type check**: `bun typecheck`

## Database Schema (4 tables)

- **`provider_accounts`**: OAuth credentials per provider (codex/claude). Includes access/refresh tokens, expiry, primary flag, metadata JSON, distributed refresh lock fields.
- **`api_keys`**: Proxy auth keys (`kleis_*` format). Provider and model scope arrays. Each key gets a `modelsDiscoveryToken` for scoped model URLs.
- **`oauth_states`**: Ephemeral records for in-flight OAuth flows.
- **`request_usage_buckets`**: Minute-bucketed analytics. Tracks request/success/error counts and latency per key+account+provider+endpoint.

**Migrations**: Never write migration files by hand. Edit `src/db/schema.ts`, then run `bun db:generate` to create the migration. Only run `bun db:migrate` if explicitly asked.

## Proxy Routes

All require `Authorization: Bearer <kleis_api_key>`:

| Route | Provider | Upstream |
|---|---|---|
| `POST /openai/v1/responses` | Codex | ChatGPT Codex responses API |
| `POST /anthropic/v1/messages` | Claude | Anthropic messages API |

## Provider Details

**Codex**: OpenAI browser (PKCE) or headless (device) flow. Injects Codex-specific headers (`ChatGPT-Account-Id`, `originator`). Strips unsupported params.

**Claude**: Anthropic PKCE flow (max or console mode). Full Claude Code identity emulation: system prompt rewriting, tool name prefixing/stripping (`mcp_` prefix), beta header injection, user-agent spoofing. Handles both streaming SSE transformation and non-streaming JSON rewriting.

## Model Registry

- `GET /api.json` - Full models.dev upstream + `kleis` aggregate provider with all configured models
- `GET /api/:modelsToken/api.json` - Scoped to API key's provider/model scopes, rewrites upstream provider URLs to Kleis proxy URLs

---

## Code Standards (Ultracite)

This project uses Ultracite (Biome-based) for formatting and linting.

- **Fix**: `bun fix` (run before committing, also runs via lefthook pre-commit)
- **Check**: `bun lint`

Write code that is type-safe and explicit. Use `unknown` over `any`, const assertions for immutable values, early returns over nested conditionals, `for...of` over `.forEach()`, `async/await` over promise chains, and template literals over concatenation. Remove `console.log`/`debugger` from production code. Throw `Error` objects, not strings.

The admin UI is vanilla JS in `public/admin/`.
