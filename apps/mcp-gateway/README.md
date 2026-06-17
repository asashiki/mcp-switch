# mcp-gateway

The public-facing service. It exposes **one** MCP endpoint (`POST /mcp`) that AI
clients (claude.ai, ChatGPT, etc.) connect to, and re-exposes the tools of every
upstream MCP server you've aggregated behind it.

MCP Switch ships **no built-in tools** — the gateway is a pure aggregator:

- **OAuth 2.1** (PKCE, dynamic client registration) — mounted when `MCP_PUBLIC_URL`
  is set. Each agent has its own identity + secret. See `src/auth/`.
- **Management console** — served at `/console` (SPA built from `apps/console-web`).
  Add/remove upstream servers, group tools, scope per-agent visibility, view audit.
  Console API lives in `src/console/`.
- **Registry** — `src/registry/remote-mcp.ts` connects to upstream MCP servers
  in-process (HTTP via Streamable HTTP, local via stdio child processes), handles
  their OAuth, and proxies calls. Server configs persist in the AuthStore
  (`src/auth/store.ts`). `src/registry/client.ts` is the thin in-process façade the
  rest of the gateway calls.
- **Tool aggregation** — upstream tools are flattened to `rmcp__<server>__<tool>`.
  Registration + JSON-Schema→Zod conversion (with argument-type coercion) lives in
  `src/tools.ts`; per-request assembly in `src/mcp.ts`.
- **MCP Apps / UI passthrough** — upstream widget resources (and the CSP in their
  `_meta`) are relayed so tool UIs render in the client.

MCP Switch is a single service — there is no separate backend.

## CLIs

```bash
# Manage agent identities for OAuth (seed/list/add/regen/enable/disable)
pnpm --filter @mcp-switch/mcp-gateway agents <cmd>
# Set the console admin password
pnpm --filter @mcp-switch/mcp-gateway exec tsx src/cli/console-admin.ts <user> <password>
```
