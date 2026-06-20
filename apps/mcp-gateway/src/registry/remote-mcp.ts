import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  connectorSchema,
  remoteMcpServerSchema,
  remoteMcpToolInvokeInputSchema,
  remoteMcpToolInvokeResultSchema,
  remoteMcpToolSchema,
  remoteMcpResourceContentsSchema
} from "@mcp-switch/schemas";
import type { RemoteMcpResourceContents } from "@mcp-switch/schemas";
import type {
  Connector,
  RemoteMcpServer,
  RemoteMcpTool,
  RemoteMcpToolInvokeResult
} from "@mcp-switch/schemas";
import { z } from "zod";

const remoteMcpServerConfigSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  // http 服务器必填真实 URL；stdio 服务器没有 URL，存 `stdio://<command>` 占位。
  url: z.string().min(1),
  // Optional: env-seeded servers often omit it. Falls back to `name` at parse time.
  description: z.string().trim().min(1).optional(),
  // 传输方式：http=远程 URL 中转（默认）；stdio=本机拉起子进程托管。
  transport: z.enum(["http", "stdio"]).default("http"),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  bearerTokenEnv: z.string().trim().min(1).optional(),
  bearerToken: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  // OAuth（授权码 + PKCE；客户端要么预注册要么 DCR 动态注册）
  oauthClientId: z.string().trim().min(1).optional(),
  oauthClientSecret: z.string().trim().min(1).optional(),
  oauthClientInfo: z.record(z.string(), z.unknown()).optional(),
  oauthTokens: z.record(z.string(), z.unknown()).optional(),
  oauthCodeVerifier: z.string().optional(),
  oauthState: z.string().optional(),
  oauthRedirectUri: z.string().optional()
});

type RemoteMcpServerConfig = z.infer<typeof remoteMcpServerConfigSchema>;

/** Persist a partial OAuth-state patch for a DB-managed server; returns false for env-defined servers. */
export type PersistRemoteOauth = (
  serverId: string,
  patch: {
    clientInfoJson?: string | null;
    tokensJson?: string | null;
    codeVerifier?: string | null;
    state?: string | null;
    redirectUri?: string | null;
  }
) => boolean;

/** Thrown in non-interactive contexts when the remote server demands a (re)authorize. */
export class RemoteAuthRequiredError extends Error {
  constructor(serverId: string) {
    super(`Remote MCP server "${serverId}" requires OAuth authorization.`);
    this.name = "RemoteAuthRequiredError";
  }
}

function hasOauthConfig(config: RemoteMcpServerConfig): boolean {
  return Boolean(config.oauthClientId || config.oauthClientInfo || config.oauthTokens);
}

/**
 * OAuthClientProvider backed by the remote_servers row. Two modes:
 * - operation (default): tokens attach + auto-refresh; a demanded re-authorize
 *   throws RemoteAuthRequiredError (server-side code can't redirect a browser).
 * - interactive (start/finish flow): captures the authorize URL via onRedirect.
 */
function makeOauthProvider(
  config: RemoteMcpServerConfig,
  persist: PersistRemoteOauth,
  interactive?: { state: string; redirectUri: string; onRedirect: (url: URL) => void }
): OAuthClientProvider {
  // Local mirrors so save→load roundtrips inside one auth() run see fresh values.
  let tokens = config.oauthTokens as OAuthTokens | undefined;
  let clientInfo: OAuthClientInformationMixed | undefined = config.oauthClientId
    ? { client_id: config.oauthClientId, ...(config.oauthClientSecret ? { client_secret: config.oauthClientSecret } : {}) }
    : (config.oauthClientInfo as OAuthClientInformationMixed | undefined);
  let verifier = config.oauthCodeVerifier;
  const redirectUri = interactive?.redirectUri ?? config.oauthRedirectUri;

  return {
    get redirectUrl() { return redirectUri; },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "MCP Switch Gateway",
        redirect_uris: redirectUri ? [redirectUri] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: config.oauthClientSecret ? "client_secret_post" : "none"
      };
    },
    state: () => interactive?.state ?? config.oauthState ?? randomUUID(),
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => {
      clientInfo = info;
      // Pre-registered clients are kept as-is; DCR results are persisted.
      if (!config.oauthClientId) persist(config.id, { clientInfoJson: JSON.stringify(info) });
    },
    tokens: () => tokens,
    saveTokens: (t) => {
      tokens = t;
      persist(config.id, { tokensJson: JSON.stringify(t) });
    },
    redirectToAuthorization: (url) => {
      if (interactive) { interactive.onRedirect(url); return; }
      throw new RemoteAuthRequiredError(config.id);
    },
    saveCodeVerifier: (v) => {
      verifier = v;
      persist(config.id, { codeVerifier: v });
    },
    codeVerifier: () => {
      if (!verifier) throw new Error(`No pending PKCE verifier for server "${config.id}".`);
      return verifier;
    },
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "tokens") { tokens = undefined; persist(config.id, { tokensJson: null }); }
      if ((scope === "all" || scope === "client") && !config.oauthClientId) {
        clientInfo = undefined;
        persist(config.id, { clientInfoJson: null });
      }
      if (scope === "all" || scope === "verifier") { verifier = undefined; persist(config.id, { codeVerifier: null }); }
    }
  };
}

type RemoteMcpServerSnapshot = {
  summary: RemoteMcpServer;
  expiresAt: number;
};

function summarizeTool(tool: Record<string, unknown>, serverId: string) {
  const inputSchema =
    typeof tool.inputSchema === "object" && tool.inputSchema !== null
      ? (tool.inputSchema as Record<string, unknown>)
      : {};
  const requiredArguments = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter(
        (item): item is string => typeof item === "string" && item.length > 0
      )
    : [];

  const meta = (tool._meta && typeof tool._meta === "object")
    ? (tool._meta as Record<string, unknown>)
    : null;
  return remoteMcpToolSchema.parse({
    serverId,
    name: typeof tool.name === "string" ? tool.name : "unknown-tool",
    title: typeof tool.title === "string" ? tool.title : null,
    description: typeof tool.description === "string" ? tool.description : null,
    readOnlyHint:
      typeof tool.annotations === "object" &&
      tool.annotations !== null &&
      typeof (tool.annotations as { readOnlyHint?: unknown }).readOnlyHint ===
        "boolean"
        ? Boolean((tool.annotations as { readOnlyHint?: boolean }).readOnlyHint)
        : false,
    requiredArguments,
    inputSchema,
    meta
  });
}

function summarizeResource(resource: Record<string, unknown>) {
  return {
    uri: typeof resource.uri === "string" ? resource.uri : "",
    name: typeof resource.name === "string" ? resource.name : null,
    title: typeof resource.title === "string" ? resource.title : null,
    description: typeof resource.description === "string" ? resource.description : null,
    mimeType: typeof resource.mimeType === "string" ? resource.mimeType : null,
    meta: (resource._meta && typeof resource._meta === "object")
      ? (resource._meta as Record<string, unknown>)
      : null
  };
}

function buildPreview(value: unknown) {
  if (typeof value === "string") {
    return value.slice(0, 400);
  }

  if (value === null || value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value, null, 2).slice(0, 400);
  } catch {
    return String(value).slice(0, 400);
  }
}

function buildRequestHeaders(
  config: RemoteMcpServerConfig,
  envSource: NodeJS.ProcessEnv
) {
  const headers: Record<string, string> = {
    ...(config.headers ?? {})
  };

  if (config.bearerToken) {
    // Raw token stored in DB (console-added servers).
    headers.Authorization = `Bearer ${config.bearerToken}`;
  } else if (config.bearerTokenEnv) {
    const token = envSource[config.bearerTokenEnv];
    if (!token) {
      throw new Error(`Missing bearer token env: ${config.bearerTokenEnv}`);
    }
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function withRemoteClient<T>(
  config: RemoteMcpServerConfig,
  envSource: NodeJS.ProcessEnv,
  callback: (client: Client) => Promise<T>,
  authProvider?: OAuthClientProvider
) {
  const client = new Client({
    name: "mcp-switch-core-remote-mcp",
    version: "0.1.0"
  });

  // stdio（本机托管）：拉起子进程，经 stdin/stdout 通信。每次调用 connect-per-call
  // 与 http 路径一致——子进程随 client.close() 退出，无需常驻守护。
  const transport = config.transport === "stdio"
    ? new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        // 合并默认安全环境（PATH 等）与用户配置的 env（如 MINIMAX_API_KEY）。
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        stderr: "ignore"
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: buildRequestHeaders(config, envSource)
        },
        // With a provider the SDK attaches the access token and auto-refreshes on
        // 401; a demanded interactive re-authorize surfaces as our
        // RemoteAuthRequiredError (thrown from redirectToAuthorization).
        ...(authProvider ? { authProvider } : {})
      });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

export function parseRemoteMcpServerConfigs(source?: string) {
  if (!source || source.trim().length === 0) {
    return [] satisfies RemoteMcpServerConfig[];
  }

  const parsed = JSON.parse(source) as unknown;
  return z
    .array(remoteMcpServerConfigSchema)
    .parse(parsed)
    .filter((item) => item.enabled)
    // `description` is required downstream (storage schema); default it to the name.
    .map((item) => ({ ...item, description: item.description ?? item.name }));
}

export function createRemoteMcpRegistry(options: {
  servers?: RemoteMcpServerConfig[];
  getServers?: () => RemoteMcpServerConfig[];
  envSource: NodeJS.ProcessEnv;
  cacheTtlMs?: number;
  /** OAuth state persistence (DB-managed servers). Absent → OAuth disabled. */
  persistOauth?: PersistRemoteOauth;
}) {
  const cacheTtlMs = options.cacheTtlMs ?? 2 * 60 * 1000;
  const cache = new Map<string, RemoteMcpServerSnapshot>();
  // Resolve the current server list dynamically (env + console-managed DB rows).
  const currentServers = (): RemoteMcpServerConfig[] =>
    options.getServers ? options.getServers() : (options.servers ?? []);

  const persist: PersistRemoteOauth = options.persistOauth ?? (() => false);
  // Operation-mode provider: only for servers with OAuth material (a provider
  // on a plain server would kick off DCR on any stray 401).
  const providerFor = (config: RemoteMcpServerConfig) =>
    hasOauthConfig(config) ? makeOauthProvider(config, persist) : undefined;

  const isAuthDemand = (error: unknown) =>
    error instanceof RemoteAuthRequiredError ||
    error instanceof UnauthorizedError ||
    /\b401\b|unauthorized|invalid_token/i.test(error instanceof Error ? error.message : String(error));

  const authModeOf = (config: RemoteMcpServerConfig) =>
    hasOauthConfig(config) ? "oauth"
      : config.bearerToken ? "bearer"
      : config.bearerTokenEnv ? "bearer-env"
      : "none";

  async function loadServerSummary(
    config: RemoteMcpServerConfig,
    force = false
  ) {
    const current = cache.get(config.id);

    if (!force && current && current.expiresAt > Date.now()) {
      return current.summary;
    }

    const seenAt = new Date().toISOString();

    try {
      const { tools: rawTools, resources: rawResources } = await withRemoteClient(
        config, options.envSource, async (client) => {
          const t = await client.listTools();
          // Resources are optional (MCP Apps widgets); a server may not support them.
          let r: { resources?: unknown[] } = {};
          const caps = client.getServerCapabilities();
          if (caps?.resources) {
            try { r = await client.listResources(); } catch { /* best-effort */ }
          }
          return { tools: t.tools, resources: r.resources ?? [] };
        }, providerFor(config)
      );

      const tools = rawTools.map((tool: Record<string, unknown>) =>
        summarizeTool(tool as Record<string, unknown>, config.id)
      );
      const resources = (rawResources as Record<string, unknown>[]).map(summarizeResource);
      const summary = remoteMcpServerSchema.parse({
        id: config.id,
        name: config.name,
        url: config.url,
        description: config.description,
        transport: config.transport,
        command: config.command,
        args: config.args,
        envKeys: config.env ? Object.keys(config.env) : undefined,
        headerKeys: config.headers ? Object.keys(config.headers) : undefined,
        authMode: authModeOf(config),
        status: "online",
        needsAuth: false,
        oauthAuthorized: Boolean(config.oauthTokens),
        lastSeenAt: seenAt,
        lastSuccessAt: seenAt,
        lastError: null,
        toolCount: tools.length,
        readOnlyToolCount: tools.filter((tool: RemoteMcpTool) => tool.readOnlyHint)
          .length,
        writeToolCount: tools.filter((tool: RemoteMcpTool) => !tool.readOnlyHint)
          .length,
        tools,
        resources
      });

      cache.set(config.id, {
        summary,
        expiresAt: Date.now() + cacheTtlMs
      });

      return summary;
    } catch (error) {
      const previous = current?.summary ?? null;
      const needsAuth = isAuthDemand(error);
      const summary = remoteMcpServerSchema.parse({
        id: config.id,
        name: config.name,
        url: config.url,
        description: config.description,
        transport: config.transport,
        command: config.command,
        args: config.args,
        envKeys: config.env ? Object.keys(config.env) : undefined,
        headerKeys: config.headers ? Object.keys(config.headers) : undefined,
        authMode: authModeOf(config),
        status: "offline",
        needsAuth,
        oauthAuthorized: Boolean(config.oauthTokens),
        lastSeenAt: seenAt,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastError: needsAuth
          ? "This server requires OAuth — click \"Authorize\" in the console to sign in."
          : error instanceof Error
            ? error.message
            : "Failed to connect to remote MCP server.",
        toolCount: previous?.toolCount ?? 0,
        readOnlyToolCount: previous?.readOnlyToolCount ?? 0,
        writeToolCount: previous?.writeToolCount ?? 0,
        tools: previous?.tools ?? []
      });

      cache.set(config.id, {
        summary,
        expiresAt: Date.now() + cacheTtlMs
      });

      return summary;
    }
  }

  function resolveServer(serverId: string) {
    const config = currentServers().find((item) => item.id === serverId);

    if (!config) {
      throw new Error(`Unknown remote MCP server: ${serverId}`);
    }

    return config;
  }

  async function listServers(force = false) {
    return Promise.all(currentServers().map((server) => loadServerSummary(server, force)));
  }

  async function listTools(serverId: string, force = false) {
    const config = resolveServer(serverId);
    const summary = await loadServerSummary(config, force);
    return summary.tools;
  }

  return {
    listServers,
    listTools,

    /**
     * Begin the OAuth authorize flow (discovery → DCR if no pre-registered
     * client → PKCE authorize URL). Returns the URL to send the browser to,
     * or `{ status: "authorized" }` when a stored refresh token still works.
     */
    async startOauth(serverId: string, redirectUri: string): Promise<{ authorizeUrl?: string; status: "redirect" | "authorized" }> {
      const config = resolveServer(serverId);
      const state = randomUUID();
      // Persist pending state up-front; also proves this is a DB-managed row.
      if (!persist(serverId, { state, redirectUri })) {
        throw new Error("OAuth is only supported for console-added servers (env-defined servers have nowhere to persist a token).");
      }
      let authorizeUrl: URL | null = null;
      const provider = makeOauthProvider(
        { ...config, oauthState: state, oauthRedirectUri: redirectUri },
        persist,
        { state, redirectUri, onRedirect: (url) => { authorizeUrl = url; } }
      );
      const result = await auth(provider, { serverUrl: config.url });
      if (result === "AUTHORIZED") {
        persist(serverId, { state: null, codeVerifier: null });
        cache.delete(serverId);
        return { status: "authorized" };
      }
      if (!authorizeUrl) throw new Error("Authorization URL was not produced by the OAuth flow.");
      return { status: "redirect", authorizeUrl: (authorizeUrl as URL).toString() };
    },

    /** Complete the authorize flow (code → tokens). Validates the CSRF state. */
    async finishOauth(serverId: string, code: string, state: string): Promise<void> {
      const config = resolveServer(serverId);
      if (!config.oauthState || config.oauthState !== state) {
        throw new Error("OAuth state mismatch — restart the authorization from the console.");
      }
      if (!config.oauthRedirectUri) throw new Error("No pending OAuth flow for this server.");
      const provider = makeOauthProvider(config, persist, {
        state,
        redirectUri: config.oauthRedirectUri,
        onRedirect: () => { throw new Error("Unexpected re-authorize during token exchange."); }
      });
      const result = await auth(provider, { serverUrl: config.url, authorizationCode: code });
      if (result !== "AUTHORIZED") throw new Error("OAuth token exchange did not complete.");
      persist(serverId, { state: null, codeVerifier: null });
      cache.delete(serverId);
    },

    async invokeTool(
      serverId: string,
      toolName: string,
      input: unknown
    ): Promise<RemoteMcpToolInvokeResult> {
      const payload = remoteMcpToolInvokeInputSchema.parse(input);
      const config = resolveServer(serverId);
      const tools = await listTools(serverId, true);
      const tool = tools.find((item: RemoteMcpTool) => item.name === toolName);

      if (!tool) {
        throw new Error(`Remote MCP tool not found: ${toolName}`);
      }

      if (!tool.readOnlyHint && !payload.allowWrite) {
        throw new Error(
          `Tool ${toolName} is not marked read-only. Set allowWrite=true only if you explicitly want to run it.`
        );
      }

      const executedAt = new Date().toISOString();

      try {
        const result = await withRemoteClient(
          config,
          options.envSource,
          async (client) =>
            client.callTool({
              name: toolName,
              arguments: payload.arguments
            }),
          providerFor(config)
        );

        const contentText =
          "content" in result && Array.isArray(result.content)
            ? result.content
                .map((item: { type?: unknown; text?: unknown } | null) =>
                  item && typeof item === "object" && item.type === "text"
                    ? String(item.text)
                    : null
                )
                .filter((item): item is string => item !== null)
                .join("\n")
            : null;
        const preview = buildPreview(
          "structuredContent" in result && result.structuredContent
            ? result.structuredContent
            : contentText
        );

        return remoteMcpToolInvokeResultSchema.parse({
          serverId,
          toolName,
          ok: !("isError" in result && Boolean(result.isError)),
          summary:
            "isError" in result && result.isError
              ? `Remote MCP tool ${toolName} returned an error.`
              : `Remote MCP tool ${toolName} executed successfully.`,
          preview,
          executedAt
        });
      } catch (error) {
        return remoteMcpToolInvokeResultSchema.parse({
          serverId,
          toolName,
          ok: false,
          summary:
            error instanceof Error
              ? error.message
              : `Remote MCP tool ${toolName} failed.`,
          preview: null,
          executedAt
        });
      }
    },

    /**
     * Invoke a remote tool and return the FULL result (content +
     * structuredContent + isError), for proxying through the MCP gateway to
     * agents. Same read-only guard as invokeTool.
     */
    async invokeToolRaw(
      serverId: string,
      toolName: string,
      input: unknown
    ): Promise<{ content: unknown[]; structuredContent: unknown; isError: boolean; meta?: unknown }> {
      const payload = remoteMcpToolInvokeInputSchema.parse(input);
      const config = resolveServer(serverId);
      const tools = await listTools(serverId, true);
      const tool = tools.find((item: RemoteMcpTool) => item.name === toolName);
      if (!tool) throw new Error(`Remote MCP tool not found: ${toolName}`);
      if (!tool.readOnlyHint && !payload.allowWrite) {
        throw new Error(`Tool ${toolName} is not marked read-only. Set allowWrite=true to run it.`);
      }
      const result = await withRemoteClient(config, options.envSource, async (client) =>
        client.callTool({ name: toolName, arguments: payload.arguments }), providerFor(config)
      );
      return {
        content: "content" in result && Array.isArray(result.content) ? result.content : [],
        structuredContent: "structuredContent" in result ? result.structuredContent : undefined,
        isError: "isError" in result ? Boolean(result.isError) : false,
        // Forward _meta (MCP Apps ui.resourceUri etc.) so the gateway can relay the widget.
        meta: "_meta" in result ? (result as { _meta?: unknown })._meta : undefined
      };
    },

    /** Read a UI/template resource from a remote server (MCP Apps widget passthrough). */
    async readResource(serverId: string, uri: string): Promise<RemoteMcpResourceContents> {
      const config = resolveServer(serverId);
      const result = await withRemoteClient(config, options.envSource, async (client) =>
        client.readResource({ uri }), providerFor(config)
      );
      const contents = Array.isArray(result.contents) ? result.contents : [];
      return remoteMcpResourceContentsSchema.parse({
        contents: contents.map((c: Record<string, unknown>) => ({
          uri: typeof c.uri === "string" ? c.uri : uri,
          mimeType: typeof c.mimeType === "string" ? c.mimeType : null,
          text: typeof c.text === "string" ? c.text : null,
          blob: typeof c.blob === "string" ? c.blob : null,
          meta: (c._meta && typeof c._meta === "object") ? (c._meta as Record<string, unknown>) : null
        }))
      });
    },

    async toConnectors(force = false): Promise<Connector[]> {
      const servers = await listServers(force);
      return servers.map((server) =>
        connectorSchema.parse({
          id: `remote-mcp-${server.id}`,
          name: server.name,
          kind: "remote-mcp",
          status: server.status,
          lastSeenAt: server.lastSeenAt,
          lastSuccessAt: server.lastSuccessAt,
          lastError: server.lastError,
          capabilities: [
            "remote-mcp",
            `tool-count:${server.toolCount}`,
            ...server.tools.slice(0, 4).map((tool) => `tool:${tool.name}`)
          ].slice(0, 12),
          exposureLevel: "private-operational"
        })
      );
    }
  };
}

export type RemoteMcpRegistry = ReturnType<typeof createRemoteMcpRegistry>;
