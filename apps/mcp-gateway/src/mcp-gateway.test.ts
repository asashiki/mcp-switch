import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpGatewayServer } from "./mcp.js";
import { createMcpGatewayApp } from "./app.js";
import type { RegistryClient } from "./registry/client.js";
import { MCP_APP_MIME_TYPE, proxyToolName } from "./registry/proxy-metadata.js";

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
        readOnly: true,
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

test("gateway preserves rich tool metadata and isolates colliding MCP Apps resources", async () => {
  const calls: Array<{ serverId: string; args: Record<string, unknown> }> = [];
  const fakeClient = {
    async proxyRemoteMcpTool(serverId: string, _toolName: string, args: Record<string, unknown>) {
      calls.push({ serverId, args });
      return {
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        structuredContent: { kind: "image" },
        isError: false,
        meta: { ui: { resourceUri: "ui://widget/index.html" } }
      };
    }
  } as unknown as RegistryClient;

  const complexSchema = {
    type: "object",
    properties: {
      mode: { $ref: "#/$defs/mode" },
      amount: { type: "integer", minimum: 1, maximum: 9 }
    },
    required: ["mode", "amount"],
    additionalProperties: false,
    $defs: { mode: { type: "string", pattern: "^[a-z]+$" } }
  };
  const outputSchema = {
    type: "object",
    properties: { kind: { const: "image" } },
    required: ["kind"],
    additionalProperties: false
  };
  const sharedUri = "ui://widget/index.html";
  const remoteTools = ["alpha", "beta"].map((serverId) => ({
    skillId: `rmcp__${serverId}__render`,
    title: `${serverId} render`,
    description: "rich proxy",
    serverId,
    toolName: "render",
    readOnly: true,
    allowWrite: true,
    inputSchema: complexSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", mimeType: "image/svg+xml" }],
    meta: { ui: { resourceUri: sharedUri } }
  }));
  const remoteResources = ["alpha", "beta"].map((serverId) => ({
    serverId,
    uri: sharedUri,
    name: "widget",
    title: `${serverId} widget`,
    description: null,
    mimeType: "text/html+skybridge",
    meta: {
      "openai/widgetCSP": {
        connect_domains: ["https://api.example.com"],
        resource_domains: ["https://cdn.example.com"]
      }
    }
  }));

  const server = createMcpGatewayServer(fakeClient, {
    remoteTools,
    remoteResources,
    readRemoteResource: async (serverId, uri) => ({
      contents: [{ uri, mimeType: "text/html", text: `<main>${serverId}</main>` }]
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metadata-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const alpha = listed.tools.find((tool) => tool.name === "rmcp__alpha__render")!;
    const beta = listed.tools.find((tool) => tool.name === "rmcp__beta__render")!;
    assert.deepEqual(alpha.inputSchema, complexSchema, "raw JSON Schema survives the gateway");
    assert.deepEqual(alpha.outputSchema, outputSchema);
    assert.equal(alpha.annotations?.openWorldHint, false);
    assert.equal(alpha.icons?.[0]?.mimeType, "image/svg+xml");
    const alphaUri = (alpha._meta?.ui as { resourceUri?: string })?.resourceUri;
    const betaUri = (beta._meta?.ui as { resourceUri?: string })?.resourceUri;
    assert.ok(alphaUri?.startsWith("ui://mcp-switch/alpha/"));
    assert.ok(betaUri?.startsWith("ui://mcp-switch/beta/"));
    assert.notEqual(alphaUri, betaUri, "same upstream URI cannot collide after aggregation");
    assert.equal(alpha._meta?.["openai/outputTemplate"], alphaUri);

    const resources = await client.listResources();
    assert.deepEqual(new Set(resources.resources.map((resource) => resource.uri)), new Set([alphaUri, betaUri]));
    const alphaResource = resources.resources.find((resource) => resource.uri === alphaUri)!;
    assert.equal(alphaResource.mimeType, MCP_APP_MIME_TYPE);
    const read = await client.readResource({ uri: alphaUri! });
    assert.equal(read.contents[0]?.mimeType, MCP_APP_MIME_TYPE);
    assert.equal("text" in read.contents[0]! ? read.contents[0].text : undefined, "<main>alpha</main>");

    const result = await client.callTool({
      name: "rmcp__alpha__render",
      arguments: { mode: "compact", amount: "2" }
    });
    assert.equal(result.content[0]?.type, "image", "non-text result content is preserved");
    assert.equal(calls[0]?.args.amount, 2, "lossless compatibility coercion still applies");
  } finally {
    await client.close();
  }
});

test("proxy tool names remain compatible, legal, bounded, and deterministic", () => {
  assert.equal(proxyToolName("demo", "echo"), "rmcp__demo__echo");
  const unusual = proxyToolName("音乐 server", "播放/下一首");
  assert.match(unusual, /^[A-Za-z0-9_.-]{1,128}$/);
  const long = proxyToolName("server", "x".repeat(300));
  assert.equal(long.length, 128);
  assert.equal(long, proxyToolName("server", "x".repeat(300)));
});

// End-to-end through the in-process registry: a synthetic upstream MCP server is
// seeded via REMOTE_MCP_SERVERS_JSON; the gateway connects to it, discovers its
// tools, and re-exposes them on its own /mcp (anonymous mode, no separate backend).
test("gateway connects to an upstream MCP and re-exposes its tools (single service)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-switch-e2e-"));
  const upstreamApp = Fastify({ logger: false });
  const upstreamMethodCounts = new Map<string, number>();
  upstreamApp.addHook("preHandler", async (request) => {
    const body = request.body && typeof request.body === "object"
      ? request.body as { method?: unknown }
      : undefined;
    const header = request.headers["mcp-method"];
    const method = typeof header === "string"
      ? header
      : typeof body?.method === "string" ? body.method : undefined;
    if (method) upstreamMethodCounts.set(method, (upstreamMethodCounts.get(method) ?? 0) + 1);
  });
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
  const upstreamHandler = toNodeHandler(createMcpHandler(() => upstream));
  upstreamApp.all("/mcp", async (request, reply) => {
    await upstreamHandler(request.raw, reply.raw, request.body);
    return reply;
  });
  const upstreamAddress = await upstreamApp.listen({ host: "127.0.0.1", port: 0 });

  const { server: gateway } = await createMcpGatewayApp({
    env: {
      HOST: "127.0.0.1",
      PORT: 4577,
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
  const listCallsAfterStartup = upstreamMethodCounts.get("tools/list") ?? 0;

  const client = new Client(
    { name: "e2e-client", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`)));
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const listed = await client.listTools();
    assert.ok(listed.tools.find((t) => t.name === "rmcp__up__echo"), "upstream tool re-exposed");

    const res = await client.callTool({ name: "rmcp__up__echo", arguments: { count: 3 } });
    assert.ok(!res.isError);
    assert.equal((res.structuredContent as { count?: number })?.count, 3);
    const second = await client.callTool({ name: "rmcp__up__echo", arguments: { count: 4 } });
    assert.equal((second.structuredContent as { count?: number })?.count, 4);
    assert.equal(
      upstreamMethodCounts.get("tools/list") ?? 0,
      listCallsAfterStartup,
      "tool calls reuse the discovered catalog instead of reconnecting and listing first"
    );

    // The same endpoint keeps serving pre-2026 clients through the stateless
    // compatibility path; deployments do not need a flag day migration.
    const legacyClient = new Client({ name: "legacy-e2e-client", version: "0.0.0" });
    try {
      await legacyClient.connect(new StreamableHTTPClientTransport(new URL(`${gatewayAddress}/mcp`)));
      assert.notEqual(legacyClient.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.ok((await legacyClient.listTools()).tools.some((tool) => tool.name === "rmcp__up__echo"));
    } finally {
      await legacyClient.close();
    }
  } finally {
    await client.close();
    await gateway.close();
    await upstreamApp.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
