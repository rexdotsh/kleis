## Kleis Build Plan

This document is the project source of truth for implementation status, decisions, and architecture.

It is intentionally detailed so a later model can continue work without missing context.

### Last Updated

- Date: 2026-02-23
- Branch: `feat/scaffolding`
- Focus: v1 scaffold + core provider/auth/model/admin architecture

---

## 1) Product Scope (Confirmed)

Build a Vercel-first OAuth account proxy that provides:

1. one reusable base URL for coding agents,
2. admin-issued API keys for client access,
3. centralized OAuth account/token management for Copilot, Codex, Claude,
4. automatic access token refresh,
5. model discovery endpoints compatible with OpenCode expectations,
6. minimal admin UI for accounts/keys/primary selection/manual refresh.

### Required behavior by provider

- Copilot: first-party flow, no workaround hacks.
- Codex: first-party flow, no workaround hacks.
- Claude: include workaround patterns from `opencode-anthropic-auth` and `pi-mono` (no feature flag).

---

## 2) Decisions Log (User Confirmed)

1. Deployment: **Vercel-first** architecture.
2. Storage: **database** (not FS, not KV-only).
3. Security posture for v1: plaintext token and API key storage acceptable for personal use.
4. Compatibility target: OpenCode-first behavior (including anthropic workaround patterns).
5. Providers in v1: Copilot, Codex, Claude.
6. Routing policy: manual primary per provider + failover-ready design.
7. Admin auth: simple single-admin secret for v1.
8. API keys: plain storage, create/revoke/list, optional scope/expiry.
9. Model registry: fetch `models.dev` upstream and merge in proxy custom models; keep fresh.
10. Claude workaround: required headers/user-agent/system/tool normalization always on.

---

## 3) Reference Repo Survey Notes

### `opensrc/repos/github.com/anomalyco/opencode-anthropic-auth`

Key patterns to carry:

- Anthropic OAuth client id and authorize/token endpoints.
- Token refresh on expiry.
- Required betas: `oauth-2025-04-20`, `interleaved-thinking-2025-05-14`.
- User-agent identity: `claude-cli/2.1.2 (external, cli)`.
- System prompt identity: `You are Claude Code, Anthropic's official CLI for Claude.`
- Request sanitization (`OpenCode`/`opencode` replacement) and tool prefixing (`mcp_`).
- Streaming response transformation back from prefixed tool names.

### `opensrc/repos/github.com/sst/opencode`

Key patterns to carry:

- Copilot device flow and headers (`x-initiator`, `Openai-Intent`, vision header).
- Codex OAuth flow with PKCE/state and account id extraction from JWT claims.
- Codex routing to `https://chatgpt.com/backend-api/codex/responses`.
- Models.dev fetch and cache pattern (`/api.json` source).

### `opensrc/repos/github.com/badlogic/pi-mono`

Key patterns to carry:

- Provider modules separated by responsibility.
- Anthropic OAuth + Claude identity + beta header behavior.
- Claude canonical tool name normalization and reverse mapping.
- Copilot helper patterns for dynamic headers.
- Codex provider with account header and responses endpoint compatibility.

### `opensrc/repos/github.com/kaitranntt/ccs`

Key patterns to carry:

- Minimal account management operations and default account selection.
- Operational status endpoints and practical admin flows.
- Keep UX practical and avoid over-engineering.

---

## 4) Runtime and Framework Direction

### Primary direction

- Keep **Bun + Elysia** for implementation and learning goal.
- Use Elysia deployment mode compatible with Vercel Functions.
- Export app in a Vercel-detectable entrypoint.

### Notes on Hono question

- Hono is excellent for Cloudflare Workers portability.
- Current user priority is Vercel-first + Elysia learning; no framework switch during scaffold.
- Keep route/service boundaries clean so future Hono migration is possible if needed.

---

## 5) v1 Architecture

### Layers

1. `config`: env parsing + runtime flags.
2. `db`: connection + migration runner + repository helpers.
3. `domain`: account/key/model services.
4. `providers`: OAuth flows + token refresh + request transformation.
5. `routes`: admin, oauth callbacks, model discovery, proxy endpoints.
6. `ui`: minimal server-rendered HTML + lightweight JS fetch calls.

### Data model (initial)

- `provider_accounts`
  - provider (`copilot` | `codex` | `claude`)
  - label/nickname
  - primary flag
  - oauth access/refresh/expires + provider metadata
  - last refresh status/time

- `api_keys`
  - raw key (plaintext, unique)
  - label
  - optional provider/model scopes
  - optional expiry
  - revoked timestamp

- `oauth_states`
  - provider
  - state
  - PKCE verifier
  - flow metadata
  - expiry timestamp

- `system_settings` (optional)
  - key/value json for lightweight mutable config.

---

## 6) API Surface (v1)

### Public/client endpoints

- `GET /healthz`
- `GET /v1/models` (OpenAI-compatible list)
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages` (Anthropic-compatible)
- `GET /models/api.json` (models.dev-compatible merged registry)

### Admin endpoints (secret-protected)

- `GET /admin/accounts`
- `POST /admin/accounts/:provider/oauth/start`
- `POST /admin/accounts/:provider/oauth/complete`
- `POST /admin/accounts/:id/primary`
- `POST /admin/accounts/:id/refresh`
- `GET /admin/keys`
- `POST /admin/keys`
- `POST /admin/keys/:id/revoke`

### UI routes

- `GET /admin` (minimal dashboard)

---

## 7) Request Routing Strategy

### Model-to-provider resolution

Priority order:

1. explicit provider metadata in model registry,
2. model prefix convention (e.g. `copilot/`, `codex/`, `claude/`),
3. fallback mapping by known model id families.

### Account selection

1. use primary active account for provider,
2. if missing, use newest active account,
3. if none, return provider-not-configured error.

### Token refresh

- refresh on request when expired/near-expiry,
- persist refreshed tokens + last refresh metadata,
- expose manual refresh endpoint for admin.

---

## 8) Models.dev Merge Strategy

1. fetch `https://models.dev/api.json` with timeout,
2. cache in-memory with short TTL (for request latency control),
3. merge custom proxy provider/model entries,
4. expose merged data in models.dev-compatible shape,
5. derive `/v1/models` from merged + configured account availability.

---

## 9) Simplicity and Maintainability Rules for This Repo

- No framework-level over-abstraction.
- Keep provider-specific quirks isolated in provider modules.
- Keep route handlers thin and side-effect free where possible.
- Reuse shared helpers for headers/body parsing/stream pass-through.
- Avoid introducing optional infrastructure (queues/workers/cache stores) in v1.

---

## 10) Implementation Phases

### Phase A - Scaffold (current)

- [ ] project layout and config foundation
- [ ] database connector and migration runner
- [ ] domain types and repositories
- [ ] base Elysia app wiring and health route

### Phase B - Admin foundation

- [ ] admin secret auth middleware
- [ ] API key CRUD and request auth
- [ ] account CRUD + primary selection + refresh metadata
- [ ] minimal admin UI shell

### Phase C - OAuth providers

- [ ] Copilot OAuth + token handling
- [ ] Codex OAuth + account id extraction + refresh
- [ ] Claude OAuth + workaround request/response transforms

### Phase D - Proxy and models

- [ ] `/v1/chat/completions` proxy routing
- [ ] `/v1/responses` proxy routing
- [ ] `/v1/messages` anthropic-compatible proxy
- [ ] merged `models.dev` endpoint + OpenAI models list endpoint

### Phase E - polish

- [ ] ultracite check/fix clean
- [ ] docs updates (README + plan progress)
- [ ] small resilience improvements (timeouts/errors)

---

## 11) Progress Log

### 2026-02-23

- Captured requirements and constraints.
- Surveyed referenced repos and extracted implementation patterns.
- Confirmed branch and commit strategy.
- Started scaffold implementation.

---

## 12) Known Risks and Mitigations

1. Serverless callback/state continuity
   - Mitigation: store OAuth state + verifier in DB, not memory only.
2. Provider behavior drift
   - Mitigation: keep provider-specific constants isolated and easy to patch.
3. DB latency concern
   - Mitigation: keep query count low and add short in-memory caches for read-heavy paths.
4. Stream transformation bugs
   - Mitigation: central stream passthrough helper and focused tests later.

---

## 13) Deferred (explicitly out of v1)

- telemetry dashboard and usage analytics,
- quota management and auto account rotation,
- encryption/hashing hardening,
- enterprise auth/RBAC.
