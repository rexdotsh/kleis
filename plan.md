## Kleis Build Plan

This file is the canonical project handoff document for architecture, progress, and next actions.

It must be kept current so a later model can continue implementation without missing context.

### Last Updated

- Date: 2026-02-23
- Branch: `feat/scaffolding`
- Runtime direction: Cloudflare Workers + Hono + D1 + Drizzle

---

## 1) Product Scope (Locked)

Build a single OAuth account proxy for coding agents with one reusable base URL.

v1 requirements:

1. Admin-managed API keys.
2. Centralized OAuth token storage and refresh.
3. Multi-account support for Copilot, Codex, Claude.
4. Primary account selection per provider.
5. OpenCode-compatible model discovery.
6. Simple admin UI for account/key operations.

Non-goals (v1): billing, advanced telemetry, enterprise auth, complex dashboards.

---

## 2) Final Technical Decisions (Confirmed)

1. Framework/runtime: **Hono on Cloudflare Workers**.
2. Database: **Cloudflare D1**.
3. ORM/migrations: **Drizzle ORM + Drizzle Kit**.
4. Validation: **Zod + @hono/zod-validator**.
5. Types: strict, explicit, Workers bindings typed.
6. Security posture for v1: plaintext token and API key storage is acceptable (personal project).
7. Claude behavior: include workaround patterns from `opencode-anthropic-auth` and `pi-mono`; not feature-flagged.

---

## 3) Reference Implementations Survey

### `opensrc/repos/github.com/anomalyco/opencode-anthropic-auth`

Carry over:

- Anthropic OAuth flow and refresh behavior.
- Required `anthropic-beta` values (`oauth-2025-04-20`, `interleaved-thinking-2025-05-14`).
- Claude Code identity behavior (`user-agent`, system prompt text).
- Tool name normalization (`mcp_` prefix in request + reverse mapping in stream).

### `opensrc/repos/github.com/sst/opencode`

Carry over:

- Copilot first-party auth/device flow conventions.
- Codex first-party OAuth/PKCE/state/account-id extraction behavior.
- Models.dev data fetch + caching pattern.

### `opensrc/repos/github.com/badlogic/pi-mono`

Carry over:

- Provider-specific module separation.
- Claude request/stream transformation logic patterns.
- Header handling specifics for Copilot and Codex paths.

### `opensrc/repos/github.com/kaitranntt/ccs`

Carry over:

- Practical account administration UX patterns.
- Minimal surface area and operational simplicity.

---

## 4) Current Repo Baseline

- The project was switched to Hono + Wrangler in commit `46b86ca01a2c2a882f103dc1744e0abbe5ed726e`.
- Scaffold now includes route composition, typed env helpers, and Drizzle schema/repositories.
- `wrangler.jsonc` includes D1 binding + migration directory.
- `worker-configuration.d.ts` is generated via `bun run cf-typegen`.

---

## 5) Target Runtime Architecture

### Layering

1. `src/config`: env/binding parsing and typed runtime config.
2. `src/db`: Drizzle schema, D1 client helper, repositories.
3. `src/domain`: account/key/model services.
4. `src/providers`: provider adapters (copilot/codex/claude) with OAuth+refresh logic.
5. `src/http`: route modules + middleware.
6. `src/ui`: minimal admin HTML route.

### Core portability rule

- Provider and domain logic must not depend directly on Hono context.
- Hono handlers should be thin wrappers around domain services.

---

## 6) D1 Schema Plan (v1)

### `provider_accounts`

- `id` TEXT PK
- `provider` TEXT NOT NULL (`copilot` | `codex` | `claude`)
- `label` TEXT NULL
- `account_id` TEXT NULL
- `is_primary` INTEGER BOOLEAN NOT NULL DEFAULT 0
- `access_token` TEXT NOT NULL
- `refresh_token` TEXT NOT NULL
- `expires_at` INTEGER NOT NULL
- `metadata_json` TEXT NULL
- `last_refresh_at` INTEGER NULL
- `last_refresh_status` TEXT NULL
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL

### `api_keys`

- `id` TEXT PK
- `key` TEXT UNIQUE NOT NULL (plaintext by decision)
- `label` TEXT NULL
- `provider_scope_json` TEXT NULL
- `model_scope_json` TEXT NULL
- `expires_at` INTEGER NULL
- `revoked_at` INTEGER NULL
- `created_at` INTEGER NOT NULL

### `oauth_states`

- `state` TEXT PK
- `provider` TEXT NOT NULL
- `pkce_verifier` TEXT NULL
- `metadata_json` TEXT NULL
- `expires_at` INTEGER NOT NULL
- `created_at` INTEGER NOT NULL

---

## 7) HTTP Surface Plan (v1)

### Public proxy routes

- `GET /healthz`
- `GET /v1/models`
- `GET /models/api.json`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

### Admin routes (`Authorization: Bearer <ADMIN_TOKEN>`)

- `GET /admin/accounts`
- `POST /admin/accounts/:id/primary`
- `POST /admin/accounts/:id/refresh`
- `POST /admin/accounts/:provider/oauth/start`
- `POST /admin/accounts/:provider/oauth/complete`
- `GET /admin/keys`
- `POST /admin/keys`
- `POST /admin/keys/:id/revoke`

### Admin UI route

- `GET /admin` (minimal HTML dashboard, no heavy frontend framework)

---

## 8) Models.dev Strategy

1. Fetch `https://models.dev/api.json` (or env override).
2. Cache in worker isolate memory with TTL.
3. Merge custom proxy models for configured providers/accounts.
4. Expose a models.dev-compatible JSON route.
5. Derive `/v1/models` from merged output + configured provider availability.

Potential future optimization:

- Add KV-backed cache or scheduled refresh job if needed.

---

## 9) Immediate Work Plan (Execution)

### Phase A - Foundation

- [x] Update docs (`AGENTS.md` + this plan) to Workers/Hono/D1 decisions.
- [x] Install dependencies: `drizzle-orm`, `zod`, `@hono/zod-validator`, `drizzle-kit`.
- [x] Configure `wrangler.jsonc` with D1 binding scaffold.
- [x] Add `drizzle.config.ts` and migration scripts.

### Phase B - Typed backend skeleton

- [x] Implement typed env/bindings module.
- [x] Add Drizzle schema and repository layer.
- [x] Replace hello app with route composition and global error handling.
- [x] Implement health endpoint and admin auth middleware.

### Phase C - Admin primitives

- [x] API key create/list/revoke endpoints.
- [x] Account list/set-primary endpoints.
- [x] Manual refresh endpoint stub wired to provider adapters.
- [x] Minimal `/admin` HTML page to invoke these endpoints.

### Phase D - Model + proxy skeleton

- [x] Implement models.dev fetch/cache/merge module.
- [x] Add `/models/api.json` and `/v1/models`.
- [x] Add proxy route scaffolds with request auth + provider resolution.
- [ ] Add provider adapter interfaces and empty implementations for next phase.

### Phase E - Provider OAuth implementation

- [ ] Copilot OAuth + refresh path.
- [x] Codex OAuth + refresh path (admin start/complete + token refresh logic).
- [ ] Claude OAuth + workaround transforms for request/stream handling.

---

## 10) Progress Log

### 2026-02-23

- Captured product charter and initial architecture in repo docs.
- Surveyed reference repos and extracted provider behavior patterns.
- Switched baseline runtime to Hono + Wrangler (existing commit by user).
- Reconfirmed stack decisions: Workers + D1 + Drizzle + strict typing.
- Began implementation from this plan.
- Installed Drizzle/Zod stack and added D1 schema + generated initial migration.
- Added admin API key and account management route skeletons.
- Added model registry fetch/cache route and OpenAI models response.
- Added API key auth middleware for `/v1/*` routes.
- Added tsgo-based typecheck command and set `noEmit` to prevent accidental `.js` output.
- Added typed provider metadata model to store provider-specific OAuth fields and header profile.
- Implemented Codex OAuth adapter with PKCE/state persistence and account id extraction from JWT claims.
- Updated provider account persistence to upsert by provider/accountId and track refresh success/failure.

---

## 11) Risks and Mitigation

1. OAuth callback continuity on serverless isolates
   - Mitigation: store state/verifier in D1, never in memory only.
2. Provider API behavior drift
   - Mitigation: isolate constants/headers/parsers in provider modules.
3. Added latency from DB checks
   - Mitigation: small in-memory TTL cache for API key/account metadata.
4. Stream transformation complexity (Claude)
   - Mitigation: central stream transform utility + narrow interfaces.

---

## 12) Handoff Notes for Future Model

- Use this file as the authoritative implementation tracker.
- Keep changes incremental and commit frequently with conventional messages.
- Preserve minimalism: prefer small explicit modules over abstractions.
- Do not introduce extra infra (queues, DO, telemetry pipelines) in v1.
