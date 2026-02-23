# Kleis

Cloudflare Workers OAuth proxy scaffold for Copilot, Codex, and Claude accounts.

## Local Dev

```txt
bun install
bun run cf-typegen
bun run dev
```

## Typecheck and Lint

```txt
bun run typecheck
bun run lint
```

- `typecheck` uses `tsgo` from `@typescript/native-preview`.
- `tsconfig.json` sets `noEmit: true`, so running TS checks does not write `.js` files into `src/`.

## D1 + Drizzle

Generate migrations from schema:

```txt
bun run db:generate
```

Apply migrations locally:

```txt
bun run db:migrate:local
```

Apply migrations remotely:

```txt
bun run db:migrate:remote
```

## Deploy

```txt
bun run deploy
```
