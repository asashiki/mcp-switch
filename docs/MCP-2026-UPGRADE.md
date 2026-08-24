# MCP 2026 compatibility in MCP Switch

MCP Switch uses the stable TypeScript SDK 2.x packages:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/client`
- `@modelcontextprotocol/node`

The public `/mcp` endpoint is mounted with `createMcpHandler()` and
`toNodeHandler()`. One server factory defines the tools and resources for both
protocol eras:

- modern 2026-07-28 requests use the per-request envelope;
- legacy 2025 clients use the SDK's stateless compatibility path.

Upstream HTTP and stdio clients opt into automatic version negotiation. A
modern upstream is used as modern; an older upstream falls back to the legacy
handshake. The gateway therefore does not require every configured MCP server
to upgrade at once.

## Access control

The SDK handler receives a validated `AuthInfo` assembled from MCP Switch's
token store. Per-agent visibility is resolved inside the per-request server
factory. Tokens without `tools:write` do not receive write-capable proxy tools
in `tools/list`.

The bearer token expiry is passed to the SDK as an epoch timestamp. This is
required by the SDK v2 authentication model and keeps an already-expired token
from being treated as valid request context.

## Lifecycle

The shared HTTP handler is closed by Fastify's `onClose` hook. Both `GET` and
`POST` are mounted because modern subscriptions may hold an SSE response while
ordinary requests normally return JSON. The handler selects the response mode;
the application no longer constructs one Streamable HTTP transport manually
for every route invocation.

## Verification

Run from `apps/mcp-gateway`:

```sh
../../node_modules/.bin/tsc --noEmit
node --import tsx --test \
  src/mcp-gateway.test.ts \
  src/auth/tokens.test.ts \
  src/auth/store.test.ts
```

The HTTP integration test uses an auto-negotiating SDK v2 client and asserts
that `2026-07-28` was negotiated before it discovers and invokes a tool through
the gateway.

## Follow-up work

These items are deliberately not presented as complete in this change:

- persist upstream `PriorDiscovery` results and pool long-lived upstream
  connections;
- preserve every 2026 tool field (`outputSchema`, icons, execution metadata)
  through the database and proxy response;
- namespace colliding MCP Apps resource URIs and validate with MCP App Lab;
- bind authorization codes, access tokens, and refresh tokens to the canonical
  RFC 8707 resource identifier;
- add host/origin allowlists for deployments exposed beyond loopback;
- expose cache hints and publish list-change notifications after rediscovery.

