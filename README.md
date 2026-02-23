# Kleis

One OAuth control plane for coding agents.

Kleis is a Cloudflare Workers proxy that centralizes Copilot, Codex, and Claude OAuth accounts,
then exposes clean API-keyed endpoints for clients.

> [!NOTE]
> "Kleis" is named from the idea of a **key** that can unlock many paths with one handle.

## Stack

- Cloudflare Workers + Hono
- D1 + Drizzle ORM
- Typed provider adapters (Copilot, Codex, Claude)
- OpenCode-oriented model discovery routes

## Quick Start

```txt
bun install
bun run cf-typegen
bun run db:migrate:local
bun run dev
```

## Core Commands

```txt
bun run typecheck
bun run lint
bun run db:generate
bun run db:migrate:local
bun run db:migrate:remote
bun run deploy
```

## Model Routing

Kleis routes provider traffic from model ids in `provider/model` format:

- `codex/<model>` -> Codex upstream
- `copilot/<model>` -> Copilot upstream
- `claude/<model>` -> Claude upstream

This keeps client config simple: override models, keep normal API usage.

## Current Scope (v1)

- Admin OAuth start/complete/refresh flows
- Primary account selection per provider
- API key issue/revoke with provider/model scopes
- `/models/api.json` and `/v1/models`
- Proxy routes for `/v1/chat/completions`, `/v1/responses`, `/v1/messages`
