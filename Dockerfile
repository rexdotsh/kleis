# syntax=docker/dockerfile:1

FROM oven/bun:1.3.10 AS base
WORKDIR /usr/src/app

FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS full-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=full-deps /usr/src/app/node_modules ./node_modules
COPY package.json bun.lock drizzle.config.ts ./
COPY src/db ./src/db
COPY drizzle ./drizzle
USER bun
CMD ["bun", "run", "db:migrate"]

FROM base AS release
ENV NODE_ENV=production
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY public ./public
USER bun
EXPOSE 3000/tcp
CMD ["bun", "run", "start"]
