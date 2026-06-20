import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServiceHealth, serviceManifestSchema } from "@mcp-switch/schemas";
import { parseServiceEnv } from "@mcp-switch/config";
import { z } from "zod";
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
  // Console SPA (decoupled frontend) CORS allowlist, comma-separated origins.
  MCP_CONSOLE_CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000")
});

export type McpGatewayEnv = z.infer<typeof mcpGatewayEnvSchema>;

export function loadMcpGatewayEnv(source: NodeJS.ProcessEnv): McpGatewayEnv {
  const normalizedSource: NodeJS.ProcessEnv = {
    ...source,
    HOST: source.MCP_GATEWAY_HOST ?? source.HOST,
    PORT: source.MCP_GATEWAY_PORT ?? source.PORT
  };

  return mcpGatewayEnvSchema.parse(
    parseServiceEnv("mcp-gateway", normalizedSource, {
      PORT: z.coerce.number().int().positive().default(4577),
      REMOTE_MCP_SERVERS_JSON: z.string().optional(),
      MCP_PUBLIC_URL: z.string().url().optional(),
      MCP_AUTH_DB_PATH: z.string().min(1).default("./data/mcp-auth.sqlite"),
      MCP_OAUTH_SCOPE: z.string().min(1).default("tools:read tools:write"),
      MCP_CONSOLE_CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000")
    })
  );
}

/**
 * Extract widget/template resource URIs referenced by a tool's _meta, across
 * the known MCP-Apps namespaces (Claude `ui.resourceUri`, ChatGPT
 * `openai/outputTemplate`). Generic: no per-server knowledge.
 */
function resourceUrisFromMeta(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta || typeof meta !== "object") return [];
  const out: string[] = [];
  const ui = meta.ui as { resourceUri?: unknown } | undefined;
  if (ui && typeof ui.resourceUri === "string") out.push(ui.resourceUri);
  const tmpl = meta["openai/outputTemplate"];
  if (typeof tmpl === "string") out.push(tmpl);
  return out;
}

export async function createMcpGatewayApp(options?: {
  env?: McpGatewayEnv;
  logger?: boolean;
  startedAt?: Date;
}) {
  const env = options?.env ?? loadMcpGatewayEnv(process.env);
  const startedAt = options?.startedAt ?? new Date();

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

  async function handleMcp(request: FastifyRequest, reply: FastifyReply, agentId?: string) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    // Filter tools/list: globally-enabled skills, narrowed to the agent's
    // allowlist when it has one.
    const enabledSkills = agentId ? store.getVisibleSkillIdsForAgent(agentId) : store.getEnabledSkillIds();
    // Upstream tools that are enabled + visible for this agent.
    const remoteTools = store.getRemoteDescriptors(enabledSkills);
    // UI resources (MCP Apps widgets) for the servers whose tools are exposed,
    // so upstream tool UIs render through the gateway.
    const remoteServerIds = new Set(remoteTools.map((t) => t.serverId));
    const remoteResources = store.getRemoteResourcesForServers(remoteServerIds);
    const mcpServer = createMcpGatewayServer(client, {
      remoteTools,
      remoteResources,
      readRemoteResource: (serverId, uri) => client.readRemoteResource(serverId, uri),
      // Console skill groups → tools/list title prefix, so the grouping shows
      // up in claude.ai / ChatGPT / Grok after the client refreshes its tools.
      groupNames: store.getSkillGroupNameMap(),
      onToolCall: (toolName, success, latencyMs) =>
        store.audit({ agentId: agentId ?? null, toolName, action: "tool_call", success, latencyMs })
    });

    reply.raw.on("close", () => {
      transport.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
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
            skillId: `rmcp__${s.id}__${tool.name}`,
            title: `${s.name}: ${tool.title ?? tool.name}`,
            category: "remote",
            source: "remote-mcp",
            enabled: tool.readOnlyHint !== false,
            description: tool.description ?? null,
            readOnly: tool.readOnlyHint,
            remoteMeta: { serverId: s.id, serverName: s.name, toolName: tool.name, inputSchema: tool.inputSchema ?? {}, readOnly: tool.readOnlyHint, toolMeta: tool.meta ?? null }
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
      pendingTtlSeconds: 600
    });

    const wwwAuth = `Bearer resource_metadata="${env.MCP_PUBLIC_URL.replace(/\/$/, "")}/.well-known/oauth-protected-resource"`;

    // Canonical MCP entrypoint — Bearer required when OAuth is enabled.
    // /mcp-oauth is kept as an alias for clients that connected during the rollout.
    const protectedMcp = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = parseBearer(request.headers.authorization);
      const ctx = token ? store.validateAccessToken(token) : null;
      if (!ctx) {
        reply.header("WWW-Authenticate", wwwAuth);
        reply.code(401);
        store.audit({ action: "mcp_unauthorized", success: false });
        return { error: "unauthorized" };
      }
      store.audit({ agentId: ctx.agentId, clientId: ctx.clientId, action: "mcp_request", success: true });
      return handleMcp(request, reply, ctx.agentId);
    };
    server.post("/mcp", protectedMcp);
    server.post("/mcp-oauth", protectedMcp);

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
    server.post("/mcp", async (request, reply) => handleMcp(request, reply));
  }

  server.addHook("onClose", async () => {
    store.close();
  });

  return { env, server, store };
}
