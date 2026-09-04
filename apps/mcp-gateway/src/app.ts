import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  createMcpHandler,
  validateHostHeader,
  validateOriginHeader,
  type AuthInfo
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServiceHealth, serviceManifestSchema } from "@mcp-switch/schemas";
import { parseServiceEnv } from "@mcp-switch/config";
import { z } from "zod/v3";
import {
  createMcpGatewayServer,
  mcpToolCatalog,
  skillMeta
} from "./mcp.js";
import { AuthStore } from "./auth/store.js";
import { createRemoteMcpRegistry, parseRemoteMcpServerConfigs } from "./registry/remote-mcp.js";
import { createRegistryClient } from "./registry/client.js";
import { registerOAuthRoutes } from "./auth/routes.js";
import { parseBearer } from "./auth/tokens.js";
import { registerConsoleApi } from "./console/api.js";
import { registerConsoleSpa } from "./console/spa.js";
import { proxyToolName, resourceUrisFromMeta } from "./registry/proxy-metadata.js";

export const mcpGatewayEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4577),
  // Optional: pre-seed upstream MCP servers as a JSON array (otherwise add via console).
  REMOTE_MCP_SERVERS_JSON: z.string().optional(),
  // OAuth + console (optional — when MCP_PUBLIC_URL is unset, only an anonymous /mcp is served).
  MCP_PUBLIC_URL: z.string().url().optional(),
  MCP_AUTH_DB_PATH: z.string().min(1).default("./data/mcp-auth.sqlite"),
  MCP_OAUTH_SCOPE: z.string().min(1).default("tools:read tools:write"),
  MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  // Console SPA (decoupled frontend) CORS allowlist, comma-separated origins.
  MCP_CONSOLE_CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  MCP_ALLOWED_HOSTS: z.string().default(""),
  MCP_ALLOWED_ORIGINS: z.string().default("")
});

export type McpGatewayEnv = z.infer<typeof mcpGatewayEnvSchema>;

// @mcp-switch/config still uses Zod 3 while the MCP SDK v2 requires Zod 4.
// Keep that package boundary structural so TypeScript does not try to compare
// both Zod type graphs (which is both invalid and extremely expensive).
const parseGatewayServiceEnv = parseServiceEnv as unknown as (
  app: "mcp-gateway",
  source: NodeJS.ProcessEnv,
  shape: Record<string, unknown>
) => unknown;

export function loadMcpGatewayEnv(source: NodeJS.ProcessEnv): McpGatewayEnv {
  const normalizedSource: NodeJS.ProcessEnv = {
    ...source,
    HOST: source.MCP_GATEWAY_HOST ?? source.HOST,
    PORT: source.MCP_GATEWAY_PORT ?? source.PORT,
    // Docker Compose represents an intentionally unset optional value as an
    // empty string. Normalize it before the URL schema runs.
    MCP_PUBLIC_URL: source.MCP_PUBLIC_URL?.trim() || undefined,
  };

  return mcpGatewayEnvSchema.parse(
    parseGatewayServiceEnv("mcp-gateway", normalizedSource, {
      PORT: z.coerce.number().int().positive().default(4577),
      REMOTE_MCP_SERVERS_JSON: z.string().optional(),
      MCP_PUBLIC_URL: z.string().url().optional(),
      MCP_AUTH_DB_PATH: z.string().min(1).default("./data/mcp-auth.sqlite"),
      MCP_OAUTH_SCOPE: z.string().min(1).default("tools:read tools:write"),
      // Keep this as a string here. mcpGatewayEnvSchema performs the single
      // string -> boolean transform after the shared service parser returns.
      MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION: z.enum(["true", "false"]).default("true"),
      MCP_CONSOLE_CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
      MCP_ALLOWED_HOSTS: z.string().default(""),
      MCP_ALLOWED_ORIGINS: z.string().default("")
    })
  );
}

export async function createMcpGatewayApp(options?: {
  env?: McpGatewayEnv;
  logger?: boolean;
  startedAt?: Date;
}) {
  const env = options?.env ?? loadMcpGatewayEnv(process.env);
  const startedAt = options?.startedAt ?? new Date();
  const issuer = env.MCP_PUBLIC_URL?.replace(/\/$/, "");
  const canonicalMcpResource = issuer ? `${issuer}/mcp` : null;

  const toHostname = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
    } catch {
      return null;
    }
  };
  const configuredHostnames = (value: string): string[] =>
    value.split(",").map(toHostname).filter((item): item is string => Boolean(item));
  const localHostnames = ["localhost", "127.0.0.1", "[::1]"];
  const publicHostname = issuer ? new URL(issuer).hostname : null;
  const allowedHostnames = [...new Set(
    env.MCP_ALLOWED_HOSTS.trim()
      ? configuredHostnames(env.MCP_ALLOWED_HOSTS)
      : [...localHostnames, ...(publicHostname ? [publicHostname] : [])]
  )];
  const allowedOriginHostnames = [...new Set(
    env.MCP_ALLOWED_ORIGINS.trim()
      ? configuredHostnames(env.MCP_ALLOWED_ORIGINS)
      : [
          ...localHostnames,
          ...(publicHostname ? [publicHostname] : []),
          ...configuredHostnames(env.MCP_CONSOLE_CORS_ORIGINS)
        ]
  )];

  // Single SQLite store holds everything: agents/OAuth/audit/skills AND the
  // upstream-server registry. The registry connects to upstream MCP servers
  // (HTTP + stdio) in-process — no separate backend service.
  const store = new AuthStore(env.MCP_AUTH_DB_PATH);
  const envRemoteServers = parseRemoteMcpServerConfigs(env.REMOTE_MCP_SERVERS_JSON);
  const registry = createRemoteMcpRegistry({
    // Merge env-defined servers with console-managed DB rows (DB wins on id).
    getServers: () => {
      const dbServers = store.listRemoteServerConfigs().filter((s) => s.enabled);
      const dbIds = new Set(dbServers.map((s) => s.id));
      return [...envRemoteServers.filter((s) => !dbIds.has(s.id)), ...dbServers];
    },
    envSource: process.env,
    persistOauth: (serverId, patch) => store.updateRemoteServerOauth(serverId, patch)
  });
  const client = createRegistryClient(registry, store);

  const manifest = serviceManifestSchema.parse({
    id: "mcp-gateway",
    name: "MCP Switch",
    port: env.PORT,
    exposure: "mcp-exposed",
    description: "Self-hosted MCP aggregation gateway"
  });

  const server = Fastify({
    logger: options?.logger ?? true
  });

  server.get("/health", async () =>
    createServiceHealth(manifest, env.NODE_ENV, startedAt)
  );

  server.get("/tools", async () => ({ tools: mcpToolCatalog.map((tool) => tool.id) }));
  server.get("/tools/catalog", async () => ({ tools: mcpToolCatalog }));

  const mcpHandler = createMcpHandler((requestContext) => {
    const agentId = typeof requestContext.authInfo?.extra?.agentId === "string"
      ? requestContext.authInfo.extra.agentId
      : undefined;
    const canRead = !requestContext.authInfo || requestContext.authInfo.scopes.includes("tools:read");
    const canWrite = !requestContext.authInfo || requestContext.authInfo.scopes.includes("tools:write");
    // Filter tools/list: globally-enabled skills, narrowed to the agent's
    // allowlist when it has one.
    const enabledSkills = agentId ? store.getVisibleSkillIdsForAgent(agentId) : store.getEnabledSkillIds();
    // Upstream tools that are enabled + visible for this agent.
    const remoteTools = store.getRemoteDescriptors(enabledSkills).filter((tool) =>
      tool.readOnly ? canRead : canWrite
    );
    // UI resources (MCP Apps widgets) for the servers whose tools are exposed,
    // so upstream tool UIs render through the gateway.
    const remoteServerIds = new Set(remoteTools.map((t) => t.serverId));
    const remoteResources = store.getRemoteResourcesForServers(remoteServerIds);
    return createMcpGatewayServer(client, {
      remoteTools,
      remoteResources,
      readRemoteResource: (serverId, uri) => client.readRemoteResource(serverId, uri),
      // Console skill groups → tools/list title prefix, so the grouping shows
      // up in claude.ai / ChatGPT / Grok after the client refreshes its tools.
      groupNames: store.getSkillGroupNameMap(),
      onToolCall: (toolName, success, latencyMs) =>
        store.audit({ agentId: agentId ?? null, toolName, action: "tool_call", success, latencyMs })
    });

  }, {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => server.log.error(error, "MCP request failed")
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  const transportHeaderRejection = (request: FastifyRequest, reply: FastifyReply) => {
    const host = validateHostHeader(request.headers.host, allowedHostnames);
    const originValue = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    const origin = validateOriginHeader(originValue, allowedOriginHostnames);
    const rejected = !host.ok ? host : !origin.ok ? origin : null;
    if (!rejected) return null;
    reply.code(403).type("application/json");
    return {
      jsonrpc: "2.0",
      error: { code: -32000, message: rejected.message },
      id: null
    };
  };

  const requiredScopeForRequest = (request: FastifyRequest): string | null => {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as { method?: unknown; params?: { name?: unknown } }
      : undefined;
    const methodHeader = request.headers["mcp-method"];
    const nameHeader = request.headers["mcp-name"];
    const method = typeof methodHeader === "string"
      ? methodHeader
      : typeof body?.method === "string" ? body.method : null;
    const name = typeof nameHeader === "string"
      ? nameHeader
      : typeof body?.params?.name === "string" ? body.params.name : null;
    if (method === "tools/call" && name) {
      return store.getSkillReadOnly(name) === false ? "tools:write" : "tools:read";
    }
    if (method === "tools/list" || method === "resources/list" || method === "resources/read") {
      return "tools:read";
    }
    return null;
  };

  async function handleMcp(
    request: FastifyRequest,
    reply: FastifyReply,
    authInfo?: AuthInfo,
    headersValidated = false
  ) {
    if (!headersValidated) {
      const rejection = transportHeaderRejection(request, reply);
      if (rejection) return rejection;
    }
    (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = authInfo;
    await nodeMcpHandler(request.raw, reply.raw, request.body);
    return reply;
  }

  // Reconcile local skills (the catalog is empty — MCP Switch ships no built-in
  // tools — so this just self-heals any stale local rows).
  store.reconcileLocalSkills(new Set(mcpToolCatalog.map((t) => t.id)));

  // Discover upstream tools and seed them into the skill registry. Read tools
  // auto-enable (add server = use it); write tools start OFF until the operator
  // flips the toggle. seedSkill never resets `enabled` on existing rows, so a
  // console toggle-off survives re-discovery. Non-fatal: a down/misconfigured
  // server won't block startup.
  const discoverRemoteSkills = async (): Promise<{ seeded: number }> => {
    let seeded = 0;
    try {
      const servers = await registry.listServers(true);
      for (const s of servers) {
        // Collect UI resources to relay: those the server lists explicitly, PLUS
        // any widget URI referenced from a tool's _meta but not listed (the spec
        // allows on-demand resources). Makes UI passthrough work for any MCP.
        const resourceByUri = new Map<string, { uri: string; name?: string | null; title?: string | null; description?: string | null; mimeType?: string | null; meta?: Record<string, unknown> | null }>();
        for (const r of s.resources ?? []) resourceByUri.set(r.uri, r);
        for (const tool of s.tools ?? []) {
          store.seedSkill({
            skillId: proxyToolName(s.id, tool.name),
            title: `${s.name}: ${tool.title ?? tool.name}`,
            category: "remote",
            source: "remote-mcp",
            enabled: tool.readOnlyHint !== false,
            description: tool.description ?? null,
            readOnly: tool.readOnlyHint,
            remoteMeta: {
              serverId: s.id,
              serverName: s.name,
              toolName: tool.name,
              inputSchema: tool.inputSchema ?? {},
              outputSchema: tool.outputSchema ?? null,
              annotations: tool.annotations ?? null,
              icons: tool.icons ?? null,
              execution: tool.execution ?? null,
              readOnly: tool.readOnlyHint,
              toolMeta: tool.meta ?? null
            }
          });
          seeded += 1;
          for (const uri of resourceUrisFromMeta(tool.meta)) {
            if (!resourceByUri.has(uri)) resourceByUri.set(uri, { uri });
          }
        }
        store.setRemoteResourcesForServer(s.id, [...resourceByUri.values()]);
      }
    } catch (e) {
      server.log.warn(`remote-mcp discovery skipped: ${e instanceof Error ? e.message : e}`);
    }
    return { seeded };
  };
  await discoverRemoteSkills();

  // ── OAuth + console (mounted only when a public URL is configured) ─────────
  if (env.MCP_PUBLIC_URL) {
    registerOAuthRoutes(server, store, {
      issuer: env.MCP_PUBLIC_URL,
      defaultScope: env.MCP_OAUTH_SCOPE,
      accessTtlSeconds: 3600,
      refreshTtlSeconds: 30 * 24 * 3600,
      codeTtlSeconds: 300,
      pendingTtlSeconds: 600,
      allowLegacyResourceOmission: env.MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION
    });

    const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
    const wwwAuth = `Bearer resource_metadata="${resourceMetadataUrl}", scope="tools:read"`;

    // Canonical MCP entrypoint — Bearer required when OAuth is enabled.
    // /mcp-oauth is kept as an alias for clients that connected during the rollout.
    const protectedMcp = async (request: FastifyRequest, reply: FastifyReply) => {
      // Reject DNS-rebinding/cross-origin transport requests before inspecting
      // bearer credentials so the protection is identical for authenticated
      // and unauthenticated traffic.
      const rejection = transportHeaderRejection(request, reply);
      if (rejection) return rejection;
      const token = parseBearer(request.headers.authorization);
      const ctx = token && canonicalMcpResource
        ? store.validateAccessToken(
            token,
            canonicalMcpResource,
            env.MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION
          )
        : null;
      if (!ctx) {
        reply.header("WWW-Authenticate", wwwAuth);
        reply.code(401);
        store.audit({ action: "mcp_unauthorized", success: false });
        return { error: "unauthorized" };
      }
      const requiredScope = requiredScopeForRequest(request);
      const grantedScopes = ctx.scope.split(/\s+/).filter(Boolean);
      if (requiredScope && !grantedScopes.includes(requiredScope)) {
        reply.header(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${resourceMetadataUrl}"`
        );
        reply.code(403);
        store.audit({ agentId: ctx.agentId, clientId: ctx.clientId, action: "mcp_insufficient_scope", success: false, detail: requiredScope });
        return { error: "insufficient_scope", required_scope: requiredScope };
      }
      store.audit({ agentId: ctx.agentId, clientId: ctx.clientId, action: "mcp_request", success: true });
      return handleMcp(request, reply, {
        token: token!,
        clientId: ctx.clientId,
        scopes: grantedScopes,
        expiresAt: ctx.expiresAt,
        extra: { agentId: ctx.agentId }
      }, true);
    };
    server.all("/mcp", protectedMcp);
    server.all("/mcp-oauth", protectedMcp);

    // JSON API for the console SPA.
    registerConsoleApi(server, store, client, {
      corsOrigins: env.MCP_CONSOLE_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
      sessionTtlSeconds: 7 * 24 * 3600,
      rediscoverRemote: discoverRemoteSkills,
      startedAt,
      publicUrl: env.MCP_PUBLIC_URL
    });

    // Console SPA at /console (built from apps/console-web). Missing dist dir →
    // routes simply not mounted (dev environments).
    const spaDir = process.env.MCP_CONSOLE_WEB_DIR ?? "console-web-dist";
    if (registerConsoleSpa(server, spaDir)) {
      server.log.info(`console SPA mounted at /console from ${spaDir}`);
    }
  } else {
    // OAuth disabled (dev / local) — anonymous /mcp exposes the enabled tools.
    server.all("/mcp", async (request, reply) => handleMcp(request, reply));
  }

  server.addHook("onClose", async () => {
    await mcpHandler.close();
    await registry.close();
    store.close();
  });

  return { env, server, store };
}
