import type { FastifyInstance } from "fastify";
import { AuthStore } from "./store.js";
import { verifyPkceS256 } from "./tokens.js";

export interface OAuthConfig {
  /** Public origin, e.g. http://127.0.0.1:4200 (no trailing slash). */
  issuer: string;
  /** Default scope granted at authorization time. */
  defaultScope: string;
  accessTtlSeconds: number;   // e.g. 3600
  refreshTtlSeconds: number;  // e.g. 30d
  codeTtlSeconds: number;     // e.g. 300
  pendingTtlSeconds: number;  // e.g. 600
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c)
  );
}

function consentPage(opts: {
  pendingId: string;
  clientName: string;
  redirectHost: string;
  scope: string;
  agents: { agentId: string; displayName: string }[];
  error?: string;
}): string {
  const agentOptions = opts.agents
    .map((a) => `<option value="${htmlEscape(a.agentId)}">${htmlEscape(a.displayName)} (${htmlEscape(a.agentId)})</option>`)
    .join("");
  const errBlock = opts.error
    ? `<div class="err">${htmlEscape(opts.error)}</div>`
    : "";
  // Sakura palette (same tokens as the console SPA; light/dark follows the OS).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Switch — Authorize</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff2f9; --surface:#ffffff; --border:#f3dce9; --border-strong:#e9c4d9;
    --text:#3a3340; --text-2:#8a7d8f; --text-3:#b8aabb;
    --accent:#e96ba8; --accent-2:#8b8bef; --accent-soft:#fdd9ec; --on-accent:#fff;
    --err:#d04848; --err-soft:#f7d5d5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#17141d; --surface:#1e1a24; --border:#332a3a; --border-strong:#46394f;
      --text:#f0e9f2; --text-2:#a796ad; --text-3:#6f6178;
      --accent:#f288c0; --accent-2:#a3a3f7; --accent-soft:#3c2535; --on-accent:#241420;
      --err:#e36868; --err-soft:#3a1f1f;
    }
  }
  * { box-sizing: border-box; }
  body { font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans","Noto Sans",sans-serif;
         margin:0; min-height:100vh; padding:2.4rem 1rem; color:var(--text);
         background:
           radial-gradient(1200px 500px at 50% -10%, var(--accent-soft), transparent 60%),
           var(--bg);
         display:flex; align-items:flex-start; justify-content:center; }
  .card { background:var(--surface); max-width:430px; width:100%; border-radius:18px;
          border:1px solid var(--border); padding:1.9rem 1.8rem 2rem;
          box-shadow:0 18px 50px -20px rgba(233,107,168,.35); }
  .brand { display:flex; align-items:center; gap:.6rem; margin-bottom:1.3rem; }
  .mark { width:30px; height:30px; border-radius:9px; transform:skewX(-12deg);
          background:var(--accent); }
  .brand b { font-size:.95rem; letter-spacing:.02em; }
  .brand span { color:var(--text-3); font-size:.72rem; letter-spacing:.14em; text-transform:uppercase; }
  h1 { font-size:1.28rem; margin:0 0 .4rem; line-height:1.3; }
  .sub { color:var(--text-2); font-size:.88rem; margin:0 0 1.4rem; line-height:1.6; }
  .panel { background:var(--bg); border:1px solid var(--border); border-radius:12px;
           padding:.5rem .9rem; margin-bottom:1.4rem; }
  .panel .row { display:flex; justify-content:space-between; align-items:center; gap:1rem;
                padding:.55rem 0; border-bottom:1px solid var(--border); }
  .panel .row:last-child { border-bottom:none; }
  .panel .k { color:var(--text-2); font-size:.82rem; flex:0 0 auto; }
  .panel .v { font-weight:600; font-size:.88rem; text-align:right; word-break:break-all; }
  label.field { display:block; font-size:.8rem; color:var(--text-2); margin:0 0 .4rem; font-weight:500; }
  .ctrl { margin-bottom:1.1rem; }
  input, select { width:100%; padding:.7rem .75rem; border:1px solid var(--border-strong);
                  border-radius:10px; font-size:.95rem; background:var(--surface); color:var(--text);
                  font-family:inherit; outline:none; transition:border-color .15s, box-shadow .15s; }
  input:focus, select:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .actions { display:flex; gap:.7rem; margin-top:1.5rem; }
  button { flex:1; padding:.8rem; border:none; border-radius:11px; font-size:.95rem; font-weight:600;
           cursor:pointer; font-family:inherit; transition:filter .15s, background .15s; }
  .approve { background:var(--accent); color:var(--on-accent); }
  .approve:hover { filter:brightness(1.05); }
  .deny { background:transparent; color:var(--text-2); border:1px solid var(--border-strong); }
  .deny:hover { background:var(--bg); }
  .err { background:var(--err-soft); color:var(--err); padding:.65rem .8rem; border-radius:10px;
         font-size:.85rem; margin-bottom:1.1rem; }
  .foot { margin-top:1.3rem; color:var(--text-3); font-size:.74rem; line-height:1.6; text-align:center; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="mark"></div>
      <div>
        <b>MCP Switch</b><br>
        <span>connection request</span>
      </div>
    </div>
    <h1>Connect an AI to your tool hub</h1>
    <p class="sub">The client below wants to connect as one of your agents. Once you approve, it can call the tools you've exposed to that agent in the console.</p>
    ${errBlock}
    <div class="panel">
      <div class="row"><span class="k">Client</span><span class="v">${htmlEscape(opts.clientName)}</span></div>
      <div class="row"><span class="k">Redirect</span><span class="v">${htmlEscape(opts.redirectHost)}</span></div>
    </div>
    <form method="POST" action="/oauth/approve">
      <input type="hidden" name="pending" value="${htmlEscape(opts.pendingId)}">
      <div class="ctrl">
        <label class="field" for="agent_id">Connect as which agent</label>
        <select id="agent_id" name="agent_id" required>${agentOptions}</select>
      </div>
      <div class="ctrl">
        <label class="field" for="agent_secret">That agent's secret</label>
        <input id="agent_secret" name="agent_secret" type="password" autocomplete="off" required placeholder="amcp_sk_...">
      </div>
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
      </div>
    </form>
    <div class="foot">You can adjust per-agent tool visibility anytime on the console's Skills page.</div>
  </div>
</body>
</html>`;
}

export function registerOAuthRoutes(server: FastifyInstance, store: AuthStore, config: OAuthConfig) {
  // OAuth uses application/x-www-form-urlencoded for /token and form POSTs.
  if (!server.hasContentTypeParser("application/x-www-form-urlencoded")) {
    server.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          done(null, Object.fromEntries(params.entries()));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
  }

  const issuer = config.issuer.replace(/\/$/, "");

  // ── Discovery metadata ────────────────────────────────────────────────────

  server.get("/.well-known/oauth-protected-resource", async () => ({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer]
  }));

  // Some clients append the resource path to the well-known prefix.
  server.get("/.well-known/oauth-protected-resource/mcp", async () => ({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer]
  }));

  const authServerMeta = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  };
  server.get("/.well-known/oauth-authorization-server", async () => authServerMeta);
  server.get("/.well-known/oauth-authorization-server/mcp", async () => authServerMeta);

  // ── Dynamic client registration ─────────────────────────────────────────

  server.post("/register", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const clientName =
      typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim()
        : "Unknown MCP Client";
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (redirectUris.length === 0) {
      reply.code(400);
      return { error: "invalid_redirect_uri", error_description: "redirect_uris is required." };
    }
    const client = store.registerClient(clientName, redirectUris);
    store.audit({ clientId: client.clientId, action: "register", success: true, detail: clientName });
    reply.code(201);
    return {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    };
  });

  // ── Authorize ─────────────────────────────────────────────────────────────

  server.get("/authorize", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string>;
    const responseType = q.response_type;
    const clientId = q.client_id;
    const redirectUri = q.redirect_uri;
    const codeChallenge = q.code_challenge;
    const codeChallengeMethod = q.code_challenge_method ?? "S256";
    const scope = q.scope?.trim() || config.defaultScope;
    const state = q.state ?? null;

    if (responseType !== "code") {
      reply.code(400); return { error: "unsupported_response_type" };
    }
    if (!clientId || !redirectUri || !codeChallenge) {
      reply.code(400); return { error: "invalid_request", error_description: "missing client_id, redirect_uri or code_challenge" };
    }
    if (codeChallengeMethod !== "S256") {
      reply.code(400); return { error: "invalid_request", error_description: "only S256 PKCE is supported" };
    }
    const client = store.getClient(clientId);
    if (!client) { reply.code(400); return { error: "invalid_client" }; }
    if (!client.redirectUris.includes(redirectUri)) {
      reply.code(400); return { error: "invalid_request", error_description: "redirect_uri not registered for this client" };
    }

    const pending = store.createPending({
      clientId, clientName: client.clientName, redirectUri,
      codeChallenge, codeChallengeMethod, scope, state,
      ttlSeconds: config.pendingTtlSeconds
    });

    reply.redirect(`/oauth/consent?pending=${encodeURIComponent(pending.pendingId)}`);
  });

  // ── Consent page ────────────────────────────────────────────────────────

  server.get("/oauth/consent", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string>;
    const pending = q.pending ? store.getPending(q.pending) : null;
    if (!pending) {
      reply.code(400).type("text/html");
      return "<p>This authorization request is invalid or has expired. Please start the connection again from your client.</p>";
    }
    let redirectHost = pending.redirectUri;
    try { redirectHost = new URL(pending.redirectUri).host; } catch { /* keep raw */ }
    const agents = store.listAgents().filter((a) => a.enabled).map((a) => ({ agentId: a.agentId, displayName: a.displayName }));
    reply.type("text/html");
    return consentPage({
      pendingId: pending.pendingId,
      clientName: pending.clientName,
      redirectHost,
      scope: pending.scope,
      agents
    });
  });

  // ── Approve / Deny ────────────────────────────────────────────────────────

  server.post("/oauth/approve", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const pending = body.pending ? store.getPending(body.pending) : null;
    if (!pending) {
      reply.code(400).type("text/html");
      return "<p>This authorization request has expired. Please start again.</p>";
    }

    const buildRedirect = (params: Record<string, string>) => {
      const url = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pending.state) url.searchParams.set("state", pending.state);
      return url.toString();
    };

    if (body.decision !== "approve") {
      store.deletePending(pending.pendingId);
      store.audit({ clientId: pending.clientId, action: "authorize_denied", success: true });
      return reply.redirect(buildRedirect({ error: "access_denied" }));
    }

    const agentId = body.agent_id;
    const agentSecret = body.agent_secret ?? "";
    if (!agentId || !store.verifyAgentSecret(agentId, agentSecret)) {
      store.audit({ agentId: agentId ?? null, clientId: pending.clientId, action: "authorize_bad_secret", success: false });
      const agents = store.listAgents().filter((a) => a.enabled).map((a) => ({ agentId: a.agentId, displayName: a.displayName }));
      reply.code(403).type("text/html");
      return consentPage({
        pendingId: pending.pendingId,
        clientName: pending.clientName,
        redirectHost: (() => { try { return new URL(pending.redirectUri).host; } catch { return pending.redirectUri; } })(),
        scope: pending.scope,
        agents,
        error: "That agent doesn't exist, is disabled, or the secret is incorrect."
      });
    }

    const code = store.issueCode({
      clientId: pending.clientId,
      agentId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      scope: pending.scope,
      ttlSeconds: config.codeTtlSeconds
    });
    store.deletePending(pending.pendingId);
    store.audit({ agentId, clientId: pending.clientId, action: "authorize_approved", success: true });
    return reply.redirect(buildRedirect({ code }));
  });

  // ── Token ───────────────────────────────────────────────────────────────

  server.post("/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const code = body.code;
      const redirectUri = body.redirect_uri;
      const codeVerifier = body.code_verifier;
      if (!code || !redirectUri || !codeVerifier) {
        reply.code(400); return { error: "invalid_request", error_description: "missing code, redirect_uri or code_verifier" };
      }
      const record = store.consumeCode(code);
      if (!record) { reply.code(400); return { error: "invalid_grant", error_description: "code invalid, expired or already used" }; }
      if (record.redirectUri !== redirectUri) {
        reply.code(400); return { error: "invalid_grant", error_description: "redirect_uri mismatch" };
      }
      if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
        store.audit({ agentId: record.agentId, clientId: record.clientId, action: "token_pkce_fail", success: false });
        reply.code(400); return { error: "invalid_grant", error_description: "PKCE verification failed" };
      }
      const pair = store.issueTokenPair({
        clientId: record.clientId,
        agentId: record.agentId,
        scope: record.scope,
        accessTtlSeconds: config.accessTtlSeconds,
        refreshTtlSeconds: config.refreshTtlSeconds
      });
      store.audit({ agentId: record.agentId, clientId: record.clientId, action: "token_issued", success: true });
      return {
        access_token: pair.accessToken,
        token_type: "Bearer",
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: record.scope
      };
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token;
      if (!refreshToken) { reply.code(400); return { error: "invalid_request", error_description: "missing refresh_token" }; }
      const result = store.rotateRefreshToken(refreshToken, {
        accessTtlSeconds: config.accessTtlSeconds,
        refreshTtlSeconds: config.refreshTtlSeconds
      });
      if ("error" in result) {
        store.audit({ action: "token_refresh_fail", success: false, detail: result.error });
        reply.code(400);
        return { error: "invalid_grant", error_description: result.error };
      }
      store.audit({ agentId: result.agentId, action: "token_refreshed", success: true });
      return {
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scope
      };
    }

    reply.code(400);
    return { error: "unsupported_grant_type" };
  });

  // ── Revoke ──────────────────────────────────────────────────────────────

  server.post("/revoke", async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const token = body.token;
    if (token) {
      store.revokeToken(token);
      store.audit({ action: "token_revoked", success: true });
    }
    // RFC 7009: always 200, even for unknown tokens.
    return {};
  });
}
