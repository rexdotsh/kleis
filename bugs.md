# Bug Backlog

Legend: `[ ]` pending, `[x]` fixed, `[-]` deferred.

## High

- [x] Provider scope bypass when JSON body is sent with non-JSON `Content-Type` (`src/http/middleware/api-key-auth.ts`).
- [x] Codex accepts `/v1/chat/completions` even though Codex proxy currently forwards to a responses-only upstream (`src/http/v1-routing.ts`, `src/providers/proxies/codex-proxy.ts`).
- [x] Claude request transform duplicates system identity block when `system` is a string (`src/providers/proxies/claude-proxy.ts`).
- [x] Provider account integrity is not DB-enforced for one-primary-per-provider and provider/account uniqueness (`src/db/schema.ts`, `src/db/repositories/provider-accounts.ts`).

## Medium

- [x] OAuth completion route can return 500 for client-side missing `code` inputs (`src/http/routes/admin-accounts.ts`).
- [x] Bearer parser is case-sensitive (`src/http/utils/bearer.ts`).
- [x] Refresh failure update can clear another worker's lock lease (`src/db/repositories/provider-accounts.ts`).
- [x] Claude transform does not prefix `tool_choice.name`, causing mismatch with prefixed tool names (`src/providers/proxies/claude-proxy.ts`).
- [x] Claude tool-name unprefixing is stream-only; non-stream JSON responses are not normalized (`src/providers/proxies/claude-proxy.ts`).
- [x] Claude stream replacement is chunk-boundary fragile (`src/providers/proxies/claude-proxy.ts`).
- [x] OAuth state completion is race-prone because state is not consumed atomically (`src/providers/*`, `src/db/repositories/oauth-states.ts`).

## Additional

- [x] Internal stack traces were exposed in HTTP 500 responses (`src/index.ts`).
