import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthStore } from "../auth/store.js";
import type { RegistryClient } from "../registry/client.js";
import { parseBearer } from "../auth/tokens.js";

// JSON API for the console SPA (apps/console-web).
// Auth: POST /api/console/login → { token }; send it as `Authorization: Bearer`.
// CORS: configurable origin allowlist so a locally-served SPA can call production.

export interface ConsoleApiConfig {
  /** Allowed browser origins for the console SPA (CORS). */
  corsOrigins: string[];
  sessionTtlSeconds: number;
  /** Re-discover remote-MCP tools (called after add/remove). */
  rediscoverRemote?: () => Promise<{ seeded: number }>;
  /** Gateway process start time (for /health uptime). */
  startedAt?: Date;
  /** Public gateway origin (MCP_PUBLIC_URL) — base of the remote OAuth redirect URI. */
  publicUrl?: string;
}

export function registerConsoleApi(
  server: FastifyInstance,
  store: AuthStore,
  client: RegistryClient,
  config: ConsoleApiConfig
) {
  if (!server.hasContentTypeParser("application/json")) {
    // default json parser exists; no-op guard
  }
  const allow = new Set(config.corsOrigins);

  // ── CORS (manual, scoped to /api/console/*) ──
  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/console")) return;
    const origin = request.headers.origin;
    if (origin && allow.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
      reply.header("Access-Control-Max-Age", "600");
    }
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  const auth = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const token = parseBearer(request.headers.authorization);
    const user = token ? store.validateConsoleSession(token) : null;
    if (!user) { reply.code(401).send({ error: "unauthorized" }); return null; }
    return user;
  };

  // ── auth ──
  server.post("/api/console/login", async (request, reply) => {
    const b = (request.body ?? {}) as { username?: string; password?: string };
    if (!b.username || !b.password || !store.verifyConsoleAdmin(b.username, b.password)) {
      reply.code(401); return { error: "invalid credentials" };
    }
    const token = store.createConsoleSession(b.username, config.sessionTtlSeconds);
    store.audit({ action: "console_api_login", success: true, detail: b.username });
    return { token, username: b.username, expiresInSeconds: config.sessionTtlSeconds };
  });

  server.get("/api/console/me", async (request, reply) => {
    const user = auth(request, reply); if (!user) return reply;
    return { username: user };
  });

  server.post("/api/console/logout", async (request, reply) => {
    const token = parseBearer(request.headers.authorization);
    if (token) store.deleteConsoleSession(token);
    return { ok: true };
  });

  // ── skills ──
  server.get("/api/console/skills", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    return { skills: store.listSkills() };
  });

  server.post("/api/console/skills/:id/enabled", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") { reply.code(400); return { error: "enabled (boolean) required" }; }
    // A remote skill can't be enabled while its server still needs OAuth — there's
    // no token to call it with, so it would only fail at invocation time.
    if (b.enabled && id.startsWith("rmcp__")) {
      const serverId = id.slice("rmcp__".length).split("__")[0];
      try {
        const servers = await client.listRemoteMcpServers();
        const s = servers.find((x) => x.id === serverId);
        if (s && (s.needsAuth || (s.authMode === "oauth" && !s.oauthAuthorized))) {
          reply.code(409);
          return { error: `Server "${s.name}" isn't authorized yet — authorize it on the Connect page before enabling its tools.` };
        }
      } catch { /* best-effort: if status check fails, don't block */ }
    }
    const ok = store.setSkillEnabled(id, b.enabled);
    if (!ok) { reply.code(404); return { error: `unknown skill: ${id}` }; }
    store.audit({ action: "skill_toggle", success: true, detail: `${id}=${b.enabled}` });
    return { skillId: id, enabled: b.enabled };
  });

  // Persist drag order (sort_order). Body: { skillIds: [...] } in desired order.
  server.post("/api/console/skills/reorder", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const b = (request.body ?? {}) as { skillIds?: unknown };
    const ids = Array.isArray(b.skillIds) ? b.skillIds.filter((x): x is string => typeof x === "string") : null;
    if (!ids) { reply.code(400); return { error: "skillIds (string[]) required" }; }
    store.reorderSkills(ids);
    return { ok: true, count: ids.length };
  });

  server.post("/api/console/skills/:id/allow-write", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { allow?: unknown };
    if (typeof b.allow !== "boolean") { reply.code(400); return { error: "allow (boolean) required" }; }
    const ok = store.setSkillAllowWrite(id, b.allow);
    if (!ok) { reply.code(404); return { error: `unknown skill: ${id}` }; }
    store.audit({ action: "skill_allow_write", success: true, detail: `${id}=${b.allow}` });
    return { skillId: id, allowWrite: b.allow };
  });

  // ── agents ──
  server.get("/api/console/agents", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    return { agents: store.listAgents() };
  });

  server.post("/api/console/agents", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const b = (request.body ?? {}) as { agentId?: string; displayName?: string };
    const id = (b.agentId ?? "").trim();
    if (!id) { reply.code(400); return { error: "agentId required" }; }
    const res = store.upsertAgent(id, (b.displayName ?? "").trim() || id);
    store.audit({ agentId: id, action: "agent_create", success: true });
    // secret is null when the agent already existed (use /regen to rotate)
    return { agentId: id, secret: res.secret };
  });

  server.post("/api/console/agents/:id/regen", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const secret = store.regenerateSecret(id);
    if (!secret) { reply.code(404); return { error: `unknown agent: ${id}` }; }
    store.audit({ agentId: id, action: "agent_regen", success: true });
    return { agentId: id, secret };
  });

  server.delete("/api/console/agents/:id", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const ok = store.deleteAgent(id);
    if (!ok) { reply.code(404); return { error: `unknown agent: ${id}` }; }
    store.audit({ agentId: id, action: "agent_delete", success: true });
    return { ok: true, deleted: id };
  });

  server.post("/api/console/agents/:id/enabled", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") { reply.code(400); return { error: "enabled (boolean) required" }; }
    const ok = store.setAgentEnabled(id, b.enabled);
    if (!ok) { reply.code(404); return { error: `unknown agent: ${id}` }; }
    store.audit({ agentId: id, action: "agent_toggle", success: true, detail: String(b.enabled) });
    return { agentId: id, enabled: b.enabled };
  });

  // Per-agent tool visibility (allowlist). Empty list → inherit (all enabled).
  server.get("/api/console/agents/:id/visibility", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    if (!store.getAgent(id)) { reply.code(404); return { error: `unknown agent: ${id}` }; }
    const allowlist = [...store.getAgentAllowlist(id)];
    return {
      agentId: id,
      restricted: store.agentHasAllowlist(id),
      allowlist,
      enabledSkills: store.listSkills().filter((s) => s.enabled).map((s) => s.skillId)
    };
  });

  server.post("/api/console/agents/:id/visibility", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    if (!store.getAgent(id)) { reply.code(404); return { error: `unknown agent: ${id}` }; }
    const b = (request.body ?? {}) as { skillIds?: unknown };
    const skillIds = Array.isArray(b.skillIds) ? b.skillIds.filter((x): x is string => typeof x === "string") : [];
    store.setAgentAllowlist(id, skillIds);
    store.audit({ agentId: id, action: "agent_visibility", success: true, detail: `${skillIds.length} skills` });
    return { agentId: id, restricted: skillIds.length > 0, allowlist: skillIds };
  });

  // ── audit ──
  server.get("/api/console/audit", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const q = (request.query ?? {}) as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 150;
    return { entries: store.recentAudit(Number.isFinite(limit) ? limit : 150) };
  });

  // ── remote MCP servers ──
  server.get("/api/console/remote", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    try {
      return { servers: await client.listRemoteMcpServers() };
    } catch (e) {
      reply.code(502); return { error: e instanceof Error ? e.message : "failed to list remote servers" };
    }
  });

  // 对齐 claude.ai 的连接器表单：Name + URL 必填；OAuth Client ID/Secret 可选
  // （预注册客户端）；Bearer Token 可选（静态 token 服务器）。无 id 时由 name 生成。
  server.post("/api/console/remote", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const b = (request.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    const id = (String(b.id ?? "").trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 48);
    try {
      // 自定义请求头（如 context7 的 CONTEXT7_API_KEY）——原样透传给目标 MCP。
      let headers: Record<string, string> | undefined;
      if (b.headers && typeof b.headers === "object" && !Array.isArray(b.headers)) {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) {
          const key = k.trim();
          if (key && (typeof v === "string" || typeof v === "number")) h[key] = String(v);
        }
        if (Object.keys(h).length) headers = h;
      }
      // stdio（本机托管）：用 command/args/env 拉起本地 MCP 子进程；http 用 url。
      const transport = b.transport === "stdio" ? "stdio" : "http";
      const command = b.command ? String(b.command).trim() : undefined;
      const args = Array.isArray(b.args) ? (b.args as unknown[]).map(String).filter((s) => s.length > 0) : undefined;
      let envVars: Record<string, string> | undefined;
      if (b.env && typeof b.env === "object" && !Array.isArray(b.env)) {
        const e: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.env as Record<string, unknown>)) {
          const key = k.trim();
          if (key && (typeof v === "string" || typeof v === "number")) e[key] = String(v);
        }
        if (Object.keys(e).length) envVars = e;
      }
      await client.addRemoteServer({
        id,
        name,
        transport,
        url: transport === "http" ? String(b.url ?? "").trim() : undefined,
        command: transport === "stdio" ? command : undefined,
        args: transport === "stdio" ? args : undefined,
        env: transport === "stdio" ? envVars : undefined,
        description: String(b.description ?? "").trim() || undefined,
        bearerToken: b.bearerToken ? String(b.bearerToken) : undefined,
        headers,
        oauthClientId: b.clientId ? String(b.clientId).trim() : undefined,
        oauthClientSecret: b.clientSecret ? String(b.clientSecret).trim() : undefined,
        enabled: true
      });
      const r = config.rediscoverRemote ? await config.rediscoverRemote() : { seeded: 0 };
      // 加了服务器就是要用它的读工具——自动启用；写工具默认保持关闭，需手动开。
      store.enableRemoteSkillsForServer(id);
      store.audit({ action: "remote_server_add", success: true, detail: id });
      // 探活一次：401/OAuth 要求 → 前端立即引导去授权
      let needsAuth = false;
      try {
        const servers = await client.listRemoteMcpServers();
        const added = servers.find((s) => s.id === id);
        needsAuth = Boolean(added?.needsAuth || (added?.authMode === "oauth" && !added?.oauthAuthorized));
      } catch { /* best-effort */ }
      return { ok: true, id, discovered: r.seeded, needsAuth };
    } catch (e) {
      reply.code(400); return { error: e instanceof Error ? e.message : "add failed" };
    }
  });

  // ── 远程 MCP OAuth：发起授权（返回跳转 URL）+ 浏览器回调（公开路由） ──
  const oauthCallbackPath = "/api/console/remote/oauth/callback";
  server.post("/api/console/remote/:id/oauth/start", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    if (!config.publicUrl) { reply.code(400); return { error: "MCP_PUBLIC_URL not configured" }; }
    const redirectUri = `${config.publicUrl.replace(/\/$/, "")}${oauthCallbackPath}`;
    try {
      const r = await client.startRemoteOauth(id, redirectUri);
      store.audit({ action: "remote_oauth_start", success: true, detail: id });
      return r;
    } catch (e) {
      reply.code(400); return { error: e instanceof Error ? e.message : "oauth start failed" };
    }
  });

  // 外部授权服务器把浏览器重定向到这里。无控制台会话（跨站跳转），以 state 为凭据；
  // state 由网关与 serverId 绑定并一次性消费。完成后跳回控制台远程页。
  server.get(oauthCallbackPath, async (request, reply) => {
    const q = (request.query ?? {}) as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (params: string) => reply.redirect(`/console/remote?${params}`);
    if (q.error) {
      store.audit({ action: "remote_oauth_callback", success: false, detail: q.error });
      return back(`oauth=err&msg=${encodeURIComponent(q.error_description || q.error)}`);
    }
    if (!q.code || !q.state) return back("oauth=err&msg=missing+code+or+state");
    try {
      const r = await client.finishRemoteOauth(q.code, q.state);
      if (config.rediscoverRemote) await config.rediscoverRemote();
      store.audit({ action: "remote_oauth_callback", success: true, detail: r.serverId });
      return back(`oauth=ok&server=${encodeURIComponent(r.serverId)}`);
    } catch (e) {
      store.audit({ action: "remote_oauth_callback", success: false, detail: e instanceof Error ? e.message : "callback failed" });
      return back(`oauth=err&msg=${encodeURIComponent(e instanceof Error ? e.message : "callback failed")}`);
    }
  });

  server.post("/api/console/remote/rediscover", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const r = config.rediscoverRemote ? await config.rediscoverRemote() : { seeded: 0 };
    store.audit({ action: "remote_rediscover", success: true, detail: `${r.seeded} tools` });
    return { ok: true, seeded: r.seeded };
  });

  // ── skill groups (user-defined scene grouping; display-only preference) ──
  server.get("/api/console/skill-groups", async (request, reply) => {
    const user = auth(request, reply); if (!user) return reply;
    return { groups: store.getSkillGroups(user) };
  });

  server.put("/api/console/skill-groups", async (request, reply) => {
    const user = auth(request, reply); if (!user) return reply;
    const b = (request.body ?? {}) as { groups?: unknown };
    if (!Array.isArray(b.groups)) { reply.code(400); return { error: "groups (array) required" }; }
    const seen = new Set<string>();
    const groups = [];
    for (const g of b.groups) {
      const r = g as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.name !== "string" || !Array.isArray(r.skillIds)) {
        reply.code(400); return { error: "each group needs id, name, skillIds[]" };
      }
      const skillIds = r.skillIds.filter((x): x is string => typeof x === "string" && !seen.has(x));
      for (const id of skillIds) seen.add(id);
      groups.push({ id: r.id, name: r.name, order: typeof r.order === "number" ? r.order : groups.length, skillIds });
    }
    store.setSkillGroups(user, groups);
    return { ok: true };
  });

  // ── system health overview ──
  server.get("/api/console/health", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const uptimeMs = config.startedAt ? Date.now() - config.startedAt.getTime() : 0;
    const d = Math.floor(uptimeMs / 86_400_000);
    const h = Math.floor((uptimeMs % 86_400_000) / 3_600_000);
    const m = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const uptime = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;

    // One connector per registered upstream MCP server (id `remote-mcp-<id>`).
    const connectors: Array<{ id: string; name: string; status: "ok" | "warn" | "err" | "disabled"; note?: string }> = [];
    try {
      const cs = await client.getConnectorStatus();
      const statusMap = { online: "ok", degraded: "warn", offline: "err" } as const;
      for (const c of cs.connectors) {
        connectors.push({
          id: c.id, name: c.name, status: statusMap[c.status],
          note: c.lastError ?? (c.lastSuccessAt ? `last ok ${c.lastSuccessAt}` : undefined)
        });
      }
    } catch { /* registry unavailable → no connectors */ }
    return { gateway: { ok: true, uptime }, connectors };
  });

  // ── call-volume stats (aggregated from audit_log tool_call rows) ──
  server.get("/api/console/stats", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const q = (request.query ?? {}) as { range?: string };
    const ranges: Record<string, { windowSeconds: number; bucketSeconds: number }> = {
      "1h": { windowSeconds: 3600, bucketSeconds: 300 },
      "24h": { windowSeconds: 86_400, bucketSeconds: 3600 },
      "7d": { windowSeconds: 604_800, bucketSeconds: 21_600 },
      "30d": { windowSeconds: 2_592_000, bucketSeconds: 86_400 }
    };
    const fallback = { windowSeconds: 86_400, bucketSeconds: 3600 };
    const range = q.range && ranges[q.range] ? q.range : "24h";
    const { windowSeconds, bucketSeconds } = ranges[range] ?? fallback;
    const cur = store.auditStats(windowSeconds, bucketSeconds);
    const prev = store.auditStats(windowSeconds, bucketSeconds, windowSeconds);

    const agents = new Map(store.listAgents().map((a) => [a.agentId, a.displayName]));
    const byAgent = cur.byAgent.map((a) => ({
      agentId: a.agentId,
      displayName: agents.get(a.agentId) ?? a.agentId,
      count: a.count,
      pct: cur.totalCalls > 0 ? a.count / cur.totalCalls : 0
    }));
    const pctDelta = (now: number, before: number) => (before > 0 ? (now - before) / before : 0);

    return {
      range,
      totalCalls: cur.totalCalls,
      errorCalls: cur.errorCalls,
      unauthorizedCalls: cur.unauthorizedCalls,
      p50LatencyMs: cur.p50LatencyMs,
      p95LatencyMs: cur.p95LatencyMs,
      timeline: cur.timeline,
      topTools: cur.topTools,
      byAgent,
      deltaVsPrev: {
        totalCalls: pctDelta(cur.totalCalls, prev.totalCalls),
        errorCalls: pctDelta(cur.errorCalls, prev.errorCalls),
        p95LatencyMs: cur.p95LatencyMs - prev.p95LatencyMs
      }
    };
  });

  server.delete("/api/console/remote/:id", async (request, reply) => {
    if (!auth(request, reply)) return reply;
    const { id } = request.params as { id: string };
    try {
      await client.deleteRemoteServer(id);
      store.pruneRemoteSkillsForServer(id);
      store.pruneRemoteResourcesForServer(id);
      if (config.rediscoverRemote) await config.rediscoverRemote();
      store.audit({ action: "remote_server_delete", success: true, detail: id });
      return { ok: true, deleted: id };
    } catch (e) {
      reply.code(400); return { error: e instanceof Error ? e.message : "delete failed" };
    }
  });
}
