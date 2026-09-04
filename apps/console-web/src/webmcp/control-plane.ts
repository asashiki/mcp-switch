import type {
  Agent,
  AppDiagnostics,
  HealthOverview,
  RemoteServer,
  Skill,
} from "@/types/api";

export const WEBMCP_DRAFT_KEY = "mcp-switch.webmcp.remote-draft";
export const WEBMCP_DRAFT_EVENT = "mcp-switch:webmcp-remote-draft";
export const WEBMCP_DIAGNOSTICS_KEY = "mcp-switch.webmcp.app-diagnostics";
export const WEBMCP_DIAGNOSTICS_EVENT = "mcp-switch:webmcp-app-diagnostics";

export interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}

export interface WebMcpModelContext {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
}

export interface RemoteServerDraft {
  name: string;
  url: string;
  description?: string;
  source: "webmcp";
  createdAt: string;
}

export interface ConsoleContext {
  route: string;
  focusedServerId: string | null;
  appLabOpen: boolean;
  draftPending: boolean;
}

export interface SwitchWebMcpDependencies {
  listServers: (signal?: AbortSignal) => Promise<{ servers: RemoteServer[] }>;
  listSkills: (signal?: AbortSignal) => Promise<{ skills: Skill[] }>;
  listAgents: (signal?: AbortSignal) => Promise<{ agents: Agent[] }>;
  getHealth: (signal?: AbortSignal) => Promise<HealthOverview>;
  diagnoseApps: (serverId: string, signal?: AbortSignal) => Promise<AppDiagnostics>;
  getConsoleContext: () => ConsoleContext;
  focusServer: (serverId: string, openAppLab: boolean, diagnostics?: AppDiagnostics) => void | Promise<void>;
  stageRemoteServerDraft: (draft: RemoteServerDraft) => void | Promise<void>;
  now?: () => Date;
}

export interface WebMcpRegistrationResult {
  registered: string[];
  failures: Array<{ name: string; message: string }>;
}

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const SERVER_REF_SCHEMA = {
  type: "object",
  properties: {
    server: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Exact upstream server ID or display name shown in MCP Switch.",
    },
  },
  required: ["server"],
  additionalProperties: false,
} as const;

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${key} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${key} must be at most ${maxLength} characters.`);
  }
  return trimmed || undefined;
}

function isHealthy(server: RemoteServer): boolean {
  const transportOnline = server.status === "online" || server.status === "ok";
  return transportOnline && !server.needsAuth && !server.lastError;
}

function publicServerSummary(server: RemoteServer, includeTools = false) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport ?? "http",
    status: server.status,
    needsAuth: Boolean(server.needsAuth),
    authMode: server.authMode,
    oauthAuthorized: Boolean(server.oauthAuthorized),
    toolCount: server.toolCount,
    hasError: Boolean(server.lastError),
    ...(includeTools ? {
      tools: server.tools.slice(0, 100).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        readOnly: tool.readOnlyHint,
      })),
      toolsTruncated: server.tools.length > 100,
    } : {}),
  };
}

function resolveServer(reference: string, servers: RemoteServer[]): RemoteServer {
  const normalized = reference.toLocaleLowerCase();
  const exactId = servers.find((server) => server.id === reference);
  if (exactId) return exactId;
  const exactName = servers.filter((server) => server.name.toLocaleLowerCase() === normalized);
  if (exactName.length === 1) return exactName[0]!;
  if (exactName.length > 1) {
    throw new Error(`More than one server is named "${reference}". Use an exact server ID.`);
  }
  const available = servers.slice(0, 12).map((server) => server.id).join(", ");
  throw new Error(`Unknown upstream server "${reference}".${available ? ` Available IDs: ${available}.` : ""}`);
}

function diagnosticSummary(diagnostics: AppDiagnostics) {
  const checks = [
    ...diagnostics.checks,
    ...diagnostics.components.flatMap((component) => component.checks),
  ];
  const problems = checks
    .filter((check) => check.severity === "warning" || check.severity === "error")
    .slice(0, 20)
    .map((check) => ({
      severity: check.severity,
      code: check.code,
      message: check.message,
      toolName: check.toolName ?? null,
      resourceUri: check.resourceUri ?? null,
    }));
  return {
    serverId: diagnostics.serverId,
    status: diagnostics.status,
    uiToolCount: diagnostics.uiToolCount,
    appResourceCount: diagnostics.appResourceCount,
    namespaceIsolation: diagnostics.namespaceIsolation,
    components: diagnostics.components.map((component) => ({
      toolName: component.toolName,
      bridge: component.bridge,
      resourceFound: component.resourceFound,
      mimeType: component.normalizedMimeType ?? component.mimeType,
      hasOutputSchema: component.hasOutputSchema,
      problemCount: component.checks.filter((check) => check.severity === "warning" || check.severity === "error").length,
    })),
    problems,
    problemsTruncated: checks.filter((check) => check.severity === "warning" || check.severity === "error").length > problems.length,
  };
}

export function createSwitchWebMcpTools(deps: SwitchWebMcpDependencies): WebMcpTool[] {
  return [
    {
      name: "mcp_switch_overview",
      title: "MCP Switch overview",
      description: "Read a concise operational overview of this signed-in MCP Switch gateway and the current console view. Does not expose secrets or change configuration.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        inputObject(rawInput);
        options?.signal?.throwIfAborted();
        const [remote, skills, agents, health] = await Promise.all([
          deps.listServers(options?.signal),
          deps.listSkills(options?.signal),
          deps.listAgents(options?.signal),
          deps.getHealth(options?.signal),
        ]);
        const enabledSkills = skills.skills.filter((skill) => skill.enabled);
        const healthyServers = remote.servers.filter(isHealthy);
        return {
          gateway: health.gateway,
          upstreams: {
            total: remote.servers.length,
            online: healthyServers.length,
            attention: remote.servers.length - healthyServers.length,
            awaitingAuthorization: remote.servers.filter((server) => server.needsAuth).length,
          },
          tools: {
            discovered: skills.skills.length,
            enabled: enabledSkills.length,
            enabledReadOnly: enabledSkills.filter((skill) => skill.readOnly !== false).length,
            enabledWrite: enabledSkills.filter((skill) => skill.readOnly === false).length,
          },
          agents: {
            registered: agents.agents.length,
            enabled: agents.agents.filter((agent) => agent.enabled).length,
          },
          console: deps.getConsoleContext(),
        };
      },
    },
    {
      name: "list_upstream_mcp_servers",
      title: "List upstream MCP servers",
      description: "List sanitized upstream MCP server status from MCP Switch. Filters to all, online, or servers needing attention. Does not return endpoints, credentials, headers, environment values, or tool descriptions.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "online", "attention"],
            default: "all",
            description: "Which server status group to return.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        const input = inputObject(rawInput);
        const status = input.status ?? "all";
        if (status !== "all" && status !== "online" && status !== "attention") {
          throw new Error("status must be all, online, or attention.");
        }
        const { servers } = await deps.listServers(options?.signal);
        const filtered = servers.filter((server) =>
          status === "all" || (status === "online" ? isHealthy(server) : !isHealthy(server)),
        );
        return {
          filter: status,
          total: filtered.length,
          servers: filtered.slice(0, 100).map((server) => publicServerSummary(server)),
          truncated: filtered.length > 100,
        };
      },
    },
    {
      name: "inspect_upstream_mcp_server",
      title: "Inspect an upstream MCP server",
      description: "Inspect one upstream MCP server by exact ID or display name. Returns sanitized connection state and at most 100 tool descriptors; never returns endpoints, credentials, headers, or environment values.",
      inputSchema: SERVER_REF_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        const input = inputObject(rawInput);
        const reference = requiredString(input, "server", 128);
        const { servers } = await deps.listServers(options?.signal);
        return publicServerSummary(resolveServer(reference, servers), true);
      },
    },
    {
      name: "open_mcp_app_lab",
      title: "Open MCP Apps compatibility lab",
      description: "Open the selected upstream in the visible MCP Switch console and run its read-only MCP Apps compatibility diagnostics. This changes only the current page view and does not invoke an upstream tool or save configuration.",
      inputSchema: SERVER_REF_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        const input = inputObject(rawInput);
        const reference = requiredString(input, "server", 128);
        const { servers } = await deps.listServers(options?.signal);
        const server = resolveServer(reference, servers);
        const diagnostics = await deps.diagnoseApps(server.id, options?.signal);
        await deps.focusServer(server.id, true, diagnostics);
        return {
          pageUpdated: true,
          upstream: { id: server.id, name: server.name },
          diagnostics: diagnosticSummary(diagnostics),
          safety: "No upstream tool was invoked and no configuration was changed.",
        };
      },
    },
    {
      name: "prepare_remote_mcp_server",
      title: "Prepare a remote MCP server draft",
      description: "Fill the visible MCP Switch remote-server form with a review-only HTTP(S) draft. This tool never saves, connects, authorizes, or discovers the server. The signed-in user must review the page and press Add manually.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Human-readable server name shown in MCP Switch.",
          },
          url: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description: "HTTP or HTTPS Streamable MCP endpoint. Do not include credentials in the URL.",
          },
          description: {
            type: "string",
            maxLength: 500,
            description: "Optional short note for the human reviewer. Do not include secrets.",
          },
        },
        required: ["name", "url"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (rawInput, options) => {
        options?.signal?.throwIfAborted();
        const input = inputObject(rawInput);
        const name = requiredString(input, "name", 80);
        const urlValue = requiredString(input, "url", 2048);
        const description = optionalString(input, "description", 500);
        let parsed: URL;
        try {
          parsed = new URL(urlValue);
        } catch {
          throw new Error("url must be a valid absolute HTTP or HTTPS URL.");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("url must use http or https.");
        }
        if (parsed.username || parsed.password) {
          throw new Error("Do not put credentials in the server URL.");
        }
        const draft: RemoteServerDraft = {
          name,
          url: parsed.toString(),
          ...(description ? { description } : {}),
          source: "webmcp",
          createdAt: (deps.now?.() ?? new Date()).toISOString(),
        };
        await deps.stageRemoteServerDraft(draft);
        return {
          status: "drafted",
          persisted: false,
          connected: false,
          draft: { name: draft.name, url: draft.url, description: draft.description ?? null },
          nextStep: "Review the highlighted draft in MCP Switch, add any credentials yourself, then press Add and discover manually.",
        };
      },
    },
  ];
}

export async function registerSwitchWebMcpTools(
  modelContext: WebMcpModelContext,
  deps: SwitchWebMcpDependencies,
  signal: AbortSignal,
): Promise<WebMcpRegistrationResult> {
  const registered: string[] = [];
  const failures: WebMcpRegistrationResult["failures"] = [];
  for (const tool of createSwitchWebMcpTools(deps)) {
    if (signal.aborted) break;
    try {
      await modelContext.registerTool(tool, { signal });
      registered.push(tool.name);
    } catch (error) {
      if (signal.aborted) break;
      failures.push({
        name: tool.name,
        message: error instanceof Error ? error.message : "registration failed",
      });
    }
  }
  return { registered, failures };
}
