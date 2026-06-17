import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpGatewayApp } from "../app.js";

const directory = mkdtempSync(join(tmpdir(), "mcp-switch-smoke-"));

const { server: mcpGateway } = await createMcpGatewayApp({
  env: {
    HOST: "127.0.0.1",
    PORT: 4200,
    NODE_ENV: "test",
    MCP_AUTH_DB_PATH: join(directory, "mcp-auth.sqlite"),
    MCP_OAUTH_SCOPE: "tools:read tools:write",
    MCP_CONSOLE_CORS_ORIGINS: ""
  },
  logger: false
});
const mcpAddress = await mcpGateway.listen({ host: "127.0.0.1", port: 0 });

const client = new Client({ name: "mcp-switch-smoke-client", version: "0.1.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpAddress}/mcp`)));
  // No upstream servers configured → empty tool list, but the endpoint works.
  await client.listTools();
  console.log("MCP Switch smoke test passed.");
} finally {
  await client.close();
  await mcpGateway.close();
  rmSync(directory, { recursive: true, force: true });
}
