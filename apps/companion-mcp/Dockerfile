FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g pnpm@9.15.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/companion-mcp ./apps/companion-mcp
COPY apps/mcp-gateway/package.json ./apps/mcp-gateway/package.json
COPY apps/console-web/package.json ./apps/console-web/package.json
RUN pnpm install --frozen-lockfile && pnpm --filter @mcp-switch/companion-mcp build
WORKDIR /app/apps/companion-mcp
RUN mkdir -p /data && chown node:node /data
USER node
ENV COMPANION_HOST=0.0.0.0 COMPANION_DATA_DIR=/data
EXPOSE 4588
CMD ["node", "dist/server.js"]
