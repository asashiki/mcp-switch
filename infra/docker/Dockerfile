# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /workspace

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/console-web/package.json apps/console-web/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/schemas/package.json packages/schemas/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .

RUN pnpm build:services

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV NPM_CONFIG_CACHE=/tmp/npm-cache
ENV XDG_CACHE_HOME=/tmp/.cache

WORKDIR /workspace/apps/mcp-gateway

COPY --from=build --chown=node:node /workspace /workspace

RUN mkdir -p /data /tmp/npm-cache /tmp/.cache \
    && chown -R node:node /data /tmp/npm-cache /tmp/.cache

USER node

CMD ["node", "dist/server.js"]
