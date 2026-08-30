import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Fastify from "fastify";
import { registerOAuthRoutes } from "./routes.js";
import { AuthStore } from "./store.js";
import { createMcpGatewayApp } from "../app.js";

const ISSUER = "https://mcp.example.com";
const RESOURCE = `${ISSUER}/mcp`;

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function authFixture(t: TestContext) {
  const path = join(tmpdir(), `mcp-switch-oauth-${randomUUID()}.sqlite`);
  const store = new AuthStore(path);
  const app = Fastify({ logger: false });
  registerOAuthRoutes(app, store, {
    issuer: ISSUER,
    defaultScope: "tools:read tools:write",
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 3600,
    codeTtlSeconds: 300,
    pendingTtlSeconds: 600,
    allowLegacyResourceOmission: false
  });
  t.after(async () => {
    await app.close();
    store.close();
    try { rmSync(path); } catch { /* ignore */ }
  });
  return { app, store };
}

test("OAuth binds code, access and refresh tokens to client and MCP resource", async (t) => {
  const { app, store } = authFixture(t);
  const registered = await app.inject({
    method: "POST",
    url: "/register",
    payload: {
      client_name: "Test Client",
      redirect_uris: ["https://client.example/callback"]
    }
  });
  assert.equal(registered.statusCode, 201);
  const clientId = registered.json().client_id as string;
  const { secret } = store.upsertAgent("test-agent", "Test Agent");
  assert.ok(secret);

  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "tools:read",
    resource: RESOURCE,
    state: "state-1"
  });
  const authorize = await app.inject({ method: "GET", url: `/authorize?${query}` });
  assert.equal(authorize.statusCode, 302);
  const pending = new URL(authorize.headers.location!, ISSUER).searchParams.get("pending");
  assert.ok(pending);

  const approve = await app.inject({
    method: "POST",
    url: "/oauth/approve",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      pending: pending!,
      decision: "approve",
      agent_id: "test-agent",
      agent_secret: secret!
    })
  });
  assert.equal(approve.statusCode, 302);
  const redirect = new URL(approve.headers.location!);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("iss"), ISSUER);
  assert.equal(redirect.searchParams.get("state"), "state-1");

  const token = await app.inject({
    method: "POST",
    url: "/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: RESOURCE
    })
  });
  assert.equal(token.statusCode, 200, token.body);
  const tokens = token.json() as { access_token: string; refresh_token: string };
  assert.equal(store.validateAccessToken(tokens.access_token, RESOURCE, false)?.resource, RESOURCE);
  assert.equal(store.validateAccessToken(tokens.access_token, "https://other.example/mcp", false), null);

  const wrongClientRefresh = await app.inject({
    method: "POST",
    url: "/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "another-client",
      resource: RESOURCE
    })
  });
  assert.equal(wrongClientRefresh.statusCode, 400);

  const refreshed = await app.inject({
    method: "POST",
    url: "/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE
    })
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(store.validateAccessToken(refreshed.json().access_token, RESOURCE, false)?.resource, RESOURCE);
});

test("OAuth rejects unsafe redirects, unknown scopes and missing/wrong resources", async (t) => {
  const { app } = authFixture(t);
  const unsafe = await app.inject({
    method: "POST",
    url: "/register",
    payload: { client_name: "Unsafe", redirect_uris: ["http://attacker.example/callback"] }
  });
  assert.equal(unsafe.statusCode, 400);

  const registered = await app.inject({
    method: "POST",
    url: "/register",
    payload: { client_name: "Safe", redirect_uris: ["http://127.0.0.1:8765/callback"] }
  });
  const clientId = registered.json().client_id as string;
  const common = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:8765/callback",
    code_challenge: "challenge",
    code_challenge_method: "S256"
  };
  const missing = await app.inject({
    method: "GET",
    url: `/authorize?${new URLSearchParams(common)}`
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "invalid_request");

  const wrong = await app.inject({
    method: "GET",
    url: `/authorize?${new URLSearchParams({ ...common, resource: "https://other.example/mcp" })}`
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, "invalid_target");

  const scope = await app.inject({
    method: "GET",
    url: `/authorize?${new URLSearchParams({ ...common, resource: RESOURCE, scope: "admin:all" })}`
  });
  assert.equal(scope.statusCode, 400);
  assert.equal(scope.json().error, "invalid_scope");
});

test("protected MCP rejects untrusted Host/Origin and challenges missing write scope", async (t) => {
  const directory = join(tmpdir(), `mcp-switch-headers-${randomUUID()}`);
  const { server, store } = await createMcpGatewayApp({
    env: {
      HOST: "127.0.0.1",
      PORT: 4577,
      NODE_ENV: "test",
      MCP_PUBLIC_URL: ISSUER,
      MCP_AUTH_DB_PATH: join(directory, "auth.sqlite"),
      MCP_OAUTH_SCOPE: "tools:read tools:write",
      MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION: false,
      MCP_CONSOLE_CORS_ORIGINS: "",
      MCP_ALLOWED_HOSTS: "",
      MCP_ALLOWED_ORIGINS: ""
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  store.upsertAgent("reader", "Reader");
  store.seedSkill({
    skillId: "rmcp__demo__write",
    title: "Write",
    category: "remote",
    source: "remote-mcp",
    enabled: true,
    readOnly: false,
    remoteMeta: { serverId: "demo", toolName: "write", inputSchema: { type: "object" }, readOnly: false }
  });
  const token = store.issueTokenPair({
    clientId: "client",
    agentId: "reader",
    scope: "tools:read",
    resource: RESOURCE,
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 3600
  }).accessToken;
  const rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "rmcp__demo__write", arguments: {} }
  };

  const badHost = await server.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: "evil.example" },
    payload: rpc
  });
  assert.equal(badHost.statusCode, 403);

  const badOrigin = await server.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "mcp.example.com",
      origin: "https://evil.example",
      authorization: `Bearer ${token}`
    },
    payload: rpc
  });
  assert.equal(badOrigin.statusCode, 403);

  const insufficient = await server.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: "mcp.example.com", authorization: `Bearer ${token}` },
    payload: rpc
  });
  assert.equal(insufficient.statusCode, 403);
  assert.match(String(insufficient.headers["www-authenticate"]), /insufficient_scope/);
  assert.match(String(insufficient.headers["www-authenticate"]), /tools:write/);
});
