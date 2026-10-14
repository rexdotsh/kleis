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

**Proxy hot path**: Turso is ~40ms away, so the proxy keeps API-key and routable-account lookups in memory (`src/db/lookup-cache.ts`). Every write to `api_keys` or `provider_accounts` must go through the repositories so it invalidates them. Usage counters are buffered in memory and flushed every 2s and on shutdown (`src/usage/usage-buffer.ts`).

**Multi-query endpoints**: send the queries as one `database.batch([...])` instead of `Promise.all`. Parallel Turso requests over HTTP occasionally stall for about a second each, and a batch is a single round trip.

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

## Code Standards (Oxc)

This project uses Oxfmt for formatting and Oxlint for linting. Their settings live in `.oxfmtrc.json` and `.oxlintrc.json`.

- **Fix**: `bun fix` (Oxlint safe fixes, then Oxfmt; also runs via lefthook pre-commit)
- **Check**: `bun lint` (Oxfmt formatting check and Oxlint)
- **Format**: `bun format` (two spaces, double quotes, semicolons, ES5 trailing commas, 80 columns)

Write code that is type-safe and explicit. Use `unknown` over `any`, const assertions for immutable values, early returns over nested conditionals, `for...of` over `.forEach()`, `async/await` over promise chains, and template literals over concatenation. Remove `console.log`/`debugger` from production code. Throw `Error` objects, not strings.

The admin UI is vanilla JS in `public/admin/`.

### Comments

Most code needs no comment. Add one only when a reader can't get it from the code itself: a non-obvious reason, an upstream quirk, a constraint that would be easy to break, or a link to the source a behavior copies.

- Describe what the code does and why, as it is now. Never describe old behavior, what was removed, what changed, or what the code doesn't do ("no longer", "used to", "instead of X we now", "intentionally absent"). That belongs in the commit message or PR.
- Don't restate the code, the name of a function or the type of a value.
- Don't narrate the task, the PR or the review that produced the code.
- One or two short lines. Don't hedge or pad.
- When code changes, fix or delete the comments it makes wrong.

---

## Pull Requests

**UI changes**: always attach screenshots of every changed screen, desktop and phone, to the PR description. Use `gh pr create --attach` or `gh pr edit --attach`, and reference each file in the body as `![alt](./file.png)` so it is placed inline. The repo is public, so screenshots must use fake data: never real account emails, IDs, keys or labels.
