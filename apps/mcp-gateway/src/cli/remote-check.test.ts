import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { createMcpGatewayApp } from "../app.js";
import { inspectRemoteGateway, normalizeMcpEndpoint } from "./remote-check-lib.js";

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a local test port");
  return port;
}

test("normalizes a public base URL without changing an exact MCP endpoint", () => {
  assert.equal(normalizeMcpEndpoint("https://example.com").toString(), "https://example.com/mcp");
  assert.equal(normalizeMcpEndpoint("https://example.com/mcp").toString(), "https://example.com/mcp");
  assert.equal(normalizeMcpEndpoint("https://example.com/canary").toString(), "https://example.com/canary/mcp");
});

test("remote checker verifies modern and legacy eras without invoking tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-switch-remote-check-"));
  const { server } = await createMcpGatewayApp({
    env: {
      HOST: "127.0.0.1",
      PORT: 4577,
      NODE_ENV: "test",
      MCP_AUTH_DB_PATH: join(directory, "auth.sqlite"),
      MCP_OAUTH_SCOPE: "tools:read tools:write",
      MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION: true,
      MCP_CONSOLE_CORS_ORIGINS: "",
      MCP_ALLOWED_HOSTS: "",
      MCP_ALLOWED_ORIGINS: ""
    },
    logger: false
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });

  try {
    const report = await inspectRemoteGateway({ endpoint: address, timeoutMs: 5_000 });
    assert.equal(report.status, "pass");
    assert.equal(report.authorizationRequired, false);
    assert.equal(report.modern?.negotiatedEra, "modern");
    assert.equal(report.modern?.protocolVersion, "2026-07-28");
    assert.equal(report.legacy?.negotiatedEra, "legacy");
    assert.deepEqual(report.modern?.toolNames, []);
    assert.deepEqual(report.legacy?.toolNames, []);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote checker follows the OAuth resource boundary with a read-only token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-switch-auth-check-"));
  const port = await reservePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const { server, store } = await createMcpGatewayApp({
    env: {
      HOST: "127.0.0.1",
      PORT: port,
      NODE_ENV: "test",
      MCP_PUBLIC_URL: publicUrl,
      MCP_AUTH_DB_PATH: join(directory, "auth.sqlite"),
      MCP_OAUTH_SCOPE: "tools:read tools:write",
      MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION: false,
      MCP_CONSOLE_CORS_ORIGINS: "",
      MCP_ALLOWED_HOSTS: "",
      MCP_ALLOWED_ORIGINS: ""
    },
    logger: false
  });
  store.upsertAgent("remote-check", "Remote Check");
  const oauthClient = store.registerClient("Remote Check", ["http://127.0.0.1/callback"]);
  const tokens = store.issueTokenPair({
    clientId: oauthClient.clientId,
    agentId: "remote-check",
    scope: "tools:read",
    resource: `${publicUrl}/mcp`,
    accessTtlSeconds: 60,
    refreshTtlSeconds: 60
  });
  await server.listen({ host: "127.0.0.1", port });

  try {
    const report = await inspectRemoteGateway({
      endpoint: publicUrl,
      bearerToken: tokens.accessToken,
      timeoutMs: 5_000
    });
    assert.equal(report.status, "pass");
    assert.equal(report.authorizationRequired, true);
    assert.equal(report.usedBearerToken, true);
    assert.equal(report.protectedResourceMetadata?.resource, `${publicUrl}/mcp`);
    assert.equal(report.modern?.negotiatedEra, "modern");
    assert.equal(report.legacy?.negotiatedEra, "legacy");
    assert.ok(report.findings.some((finding) => finding.id === "oauth.challenge" && finding.level === "pass"));
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
