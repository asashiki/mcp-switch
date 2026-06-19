import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type RemoteToolDescriptor, type RemoteResourceDescriptor } from "./tools.js";
import { mcpToolCatalogSchema } from "@mcp-switch/schemas";
import type { RegistryClient } from "./registry/client.js";

// MCP Switch ships NO built-in tools — everything exposed to agents is proxied
// from upstream MCP servers added through the console. The (empty) catalog is
// kept so the skill-registry seed/reconcile plumbing stays generic.
export const mcpToolCatalog = mcpToolCatalogSchema.parse([]);
export type McpToolId = string;
export const skillMeta: Record<string, { initialEnabled: boolean }> = {};

// Builds an MCP server instance per request. All tool registrations are remote
// (proxied) tools, wired in via tools.ts.
export function createMcpGatewayServer(
  client: RegistryClient,
  opts?: {
    remoteTools?: RemoteToolDescriptor[];
    /** UI resources exposed by upstream servers (MCP Apps widgets), for passthrough. */
    remoteResources?: RemoteResourceDescriptor[];
    /** Reads an upstream server's resource by uri (forwarded via the registry). */
    readRemoteResource?: (serverId: string, uri: string) => Promise<{ contents: Array<{ uri: string; mimeType?: string | null; text?: string | null; blob?: string | null; meta?: unknown }> }>;
    /** Per-tool-call audit hook (toolName, success, latencyMs). */
    onToolCall?: (toolName: string, success: boolean, latencyMs: number) => void;
    /**
     * skillId → console group name. MCP has no native grouping, so the group
     * is surfaced as a title prefix (「组名」Title) in tools/list — clients
     * (claude.ai / ChatGPT / Grok) pick it up on their next refresh.
     */
    groupNames?: Map<string, string>;
  }
) {
  const groupNames = opts?.groupNames;
  const remoteTools = (opts?.remoteTools ?? []).map((rt) => {
    const group = groupNames?.get(rt.skillId);
    return group ? { ...rt, title: `「${group}」${rt.title}` } : rt;
  });

  // MCP clients bucket tools by annotation in their permission UI — they can't
  // render our custom groups there. So we surface the operator's console grouping
  // in the server `instructions` instead: the model reads this on connect and
  // knows which tools belong to which group, even though the permission list is flat.
  const buildInstructions = (): string => {
    type Entry = { id: string; title: string; group: string };
    const entries: Entry[] = (opts?.remoteTools ?? []).map((rt) => ({
      id: rt.skillId,
      title: rt.title,
      group: groupNames?.get(rt.skillId) ?? "Ungrouped"
    }));
    const header =
      "MCP Switch — a self-hosted MCP aggregation gateway. The tools below are " +
      "proxied from one or more upstream MCP servers (local stdio + remote HTTP) " +
      "that the operator has aggregated behind this single endpoint.";
    if (entries.length === 0) {
      return `${header}\n\nNo upstream tools are currently exposed.`;
    }
    const byGroup = new Map<string, Entry[]>();
    for (const e of entries) {
      const arr = byGroup.get(e.group) ?? [];
      arr.push(e);
      byGroup.set(e.group, arr);
    }
    const groupOrder = [...byGroup.keys()].sort((a, b) =>
      a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b));
    const lines = groupOrder.map((g) => {
      const tools = byGroup.get(g)!.map((e) => `${e.id} (${e.title})`).join(", ");
      return `[${g}] ${tools}`;
    });
    return [
      header,
      "",
      "The operator has organized the available tools into the following groups. " +
        "Use these groupings to choose the right tool for a request:",
      ...lines
    ].join("\n");
  };

  const server = new McpServer(
    {
      name: "mcp-switch-gateway",
      version: "0.1.0"
    },
    {
      instructions: buildInstructions()
    }
  );

  // Audit every tool invocation by wrapping registerTool's callback. MCP
  // handled-errors surface as result.isError, not throws.
  const onToolCall = opts?.onToolCall;
  const origRegister = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  const auditedRegister = ((name: string, cfg: unknown, cb: (...a: unknown[]) => unknown) => {
    const wrapped = onToolCall
      ? async (...args: unknown[]) => {
          const started = Date.now();
          try {
            const result = await cb(...args);
            const isError = !!(result && typeof result === "object" && (result as { isError?: boolean }).isError);
            onToolCall(name, !isError, Date.now() - started);
            return result;
          } catch (e) {
            onToolCall(name, false, Date.now() - started);
            throw e;
          }
        }
      : cb;
    return origRegister(name, cfg, wrapped);
  }) as typeof server.registerTool;
  (server as { registerTool: typeof server.registerTool }).registerTool = auditedRegister;

  registerTools(server, client, {
    remoteTools,
    remoteResources: opts?.remoteResources ?? [],
    readRemoteResource: opts?.readRemoteResource
  });

  return server;
}
