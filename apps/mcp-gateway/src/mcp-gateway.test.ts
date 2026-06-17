import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpGatewayServer } from "./mcp.js";
import { createMcpGatewayApp } from "./app.js";
import type { RegistryClient } from "./registry/client.js";

// MCP Switch ships no built-in tools — it re-exposes upstream tools as
// `rmcp__<server>__<tool>`. This verifies the aggregation path AND the argument
// type coercion (string "730" → number 730) end-to-end through the real SDK.
test("gateway aggregates an upstream tool and coerces argument types", async () => {
  const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = [];
  const fakeClient = {
    async proxyRemoteMcpTool(serverId: string, toolName: string, args: Record<string, unknown>) {
      calls.push({ serverId, toolName, args });
      return { content: [{ type: "text", text: "ok" }], structuredContent: { echoed: args }, isError: false };
    }
  } as unknown as RegistryClient;

  const server = createMcpGatewayServer(fakeClient, {
    remoteTools: [
      {
        skillId: "rmcp__demo__get_app",
        title: "Get App",
        description: "demo",
        serverId: "demo",
        toolName: "get_app",
        allowWrite: true,
        inputSchema: {
          type: "object",
          properties: { appid: { type: "number" }, include: { type: "boolean" } },
          required: ["appid"]
        }
      }
    ]
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === "rmcp__demo__get_app");
    assert.ok(tool, "proxied tool should be listed");
    // Advertised schema preserves the upstream types.
    const props = tool!.inputSchema.properties as Record<string, { type?: string }>;
    assert.equal(props.appid?.type, "number");
    assert.equal(props.include?.type, "boolean");

    // Client sends strings; the gateway coerces before forwarding upstream.
    const res = await client.callTool({ name: "rmcp__demo__get_app", arguments: { appid: "730", include: "false" } });
    assert.ok(!res.isError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args.appid, 730);
    assert.equal(typeof calls[0]!.args.appid, "number");
    assert.equal(calls[0]!.args.include, false);
  } finally {
    await client.close();
  }
});

// End-to-end through the in-process registry: a synthetic upstream MCP server is
// seeded via REMOTE_MCP_SERVERS_JSON; the gateway connects to it, discovers its
// tools, and re-exposes them on its own /mcp (anonymous mode, no separate backend).
test("gateway connects to an upstream MCP and re-exposes its tools (single service)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-switch-e2e-"));
  const upstreamApp = Fastify({ logger: false });
  const upstream = new McpServer({ name: "upstream", version: "0.1.0" });
  upstream.registerTool(
    "echo",
    {
      title: "Echo",
      description: "echoes a count",
      inputSchema: { count: z.number().int().optional() },
      annotations: { readOnlyHint: true }
    },
    async (input: { count?: number }) => ({
      content: [{ type: "text" as const, text: `count=${input.count ?? 0}` }],
      structuredContent: { count: input.count ?? 0 }
    })
  );
  upstreamApp.post("/mcp", async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => transport.close());
    await upstream.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });
  const upstreamAddress = await upstreamApp.listen({ host: "127.0.0.1", port: 0 });

  const { server: gateway } = await createMcpGatewayApp({
    env: {
      HOST: "127.0.0.1",
      PORT: 4200,
      NODE_ENV: "test",
      MCP_AUTH_DB_PATH: join(directory, "mcp-auth.sqlite"),
      MCP_OAUTH_SCOPE: "tools:read tools:write",
      MCP_CONSOLE_CORS_ORIGINS: "",
      REMOTE_MCP_SERVERS_JSON: JSON.stringify([
        { id: "up", name: "Upstream", url: `${upstreamAddress}/mcp`, description: "synthetic" }
      ])
    },
    logger: false
  });
  const gatewayAddress = await gateway.listen({ host: "127.0.0.1", port: 0 });

  const client = new Client({ name: "e2e-client", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`)));
    const listed = await client.listTools();
    assert.ok(listed.tools.find((t) => t.name === "rmcp__up__echo"), "upstream tool re-exposed");

    const res = await client.callTool({ name: "rmcp__up__echo", arguments: { count: 3 } });
    assert.ok(!res.isError);
    assert.equal((res.structuredContent as { count?: number })?.count, 3);
  } finally {
    await client.close();
    await gateway.close();
    await upstreamApp.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
