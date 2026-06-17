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

FROM deps AS runtime

COPY . .

RUN pnpm build:services

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@mcp-switch/mcp-gateway", "start"]
