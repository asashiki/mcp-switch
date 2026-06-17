import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RegistryClient } from "./registry/client.js";

export interface RemoteToolDescriptor {
  skillId: string;
  title: string;
  description: string | null;
  serverId: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  allowWrite: boolean;
  /** Tool-definition _meta (MCP Apps ui.resourceUri / openai outputTemplate). */
  meta?: Record<string, unknown> | null;
}

export interface RemoteResourceDescriptor {
  serverId: string;
  uri: string;
  name: string | null;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  meta: Record<string, unknown> | null;
}

// MCP clients (and the models behind them) sometimes serialize every tool
// argument as a string ("730", "true", "[1,2]"). The downstream remote server
// validates with its own strict Zod schema and rejects the wrong JS type. So we
// rebuild the remote tool's JSON Schema into a typed Zod schema that (a) ADVERTISES
// the correct type back to the client (model sends the right type), and (b)
// COERCES a stray string to the right type before we forward it. preprocess keeps
// the advertised JSON Schema as the inner type (pipeStrategy: 'input').
const coerceNumber = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
const coerceBool = (v: unknown) =>
  v === "true" ? true : v === "false" ? false : v;
const coerceJson = (v: unknown) => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return v;
  try { return JSON.parse(s); } catch { return v; }
};

function jsonSchemaTypeToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const rawType = prop?.type;
  const type = Array.isArray(rawType)
    ? (rawType as unknown[]).map(String).find((x) => x !== "null")
    : typeof rawType === "string" ? rawType : undefined;

  // enum of strings → keep as string (constraint surfaces in JSON Schema).
  if (Array.isArray(prop?.enum) && (prop.enum as unknown[]).every((e) => typeof e === "string") && (prop.enum as unknown[]).length) {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  switch (type) {
    case "string":
      return z.string();
    case "integer":
    case "number":
      return z.preprocess(coerceNumber, z.number());
    case "boolean":
      return z.preprocess(coerceBool, z.boolean());
    case "array": {
      const items = (prop?.items && typeof prop.items === "object" && !Array.isArray(prop.items))
        ? jsonSchemaTypeToZod(prop.items as Record<string, unknown>)
        : z.unknown();
      return z.preprocess(coerceJson, z.array(items));
    }
    case "object": {
      const nested = (prop?.properties && typeof prop.properties === "object")
        ? z.object(jsonSchemaToRawShape(prop as Record<string, unknown>)).passthrough()
        : z.record(z.string(), z.unknown());
      return z.preprocess(coerceJson, nested);
    }
    default:
      // Unknown/missing type: stay permissive (don't break the call).
      return z.unknown();
  }
}

function jsonSchemaToRawShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  for (const [key, prop] of Object.entries(props)) {
    let t = jsonSchemaTypeToZod(prop ?? {});
    const desc = prop && typeof prop.description === "string" ? prop.description : undefined;
    if (desc) t = t.describe(desc);
    if (!required.includes(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

export interface ToolContext {
  /** Flattened remote tools to re-expose as top-level `rmcp__<server>__<tool>`. */
  remoteTools: RemoteToolDescriptor[];
  /** UI resources exposed by upstream servers (MCP Apps widgets), for passthrough. */
  remoteResources?: RemoteResourceDescriptor[];
  readRemoteResource?: (serverId: string, uri: string) => Promise<{ contents: Array<{ uri: string; mimeType?: string | null; text?: string | null; blob?: string | null; meta?: unknown }> }>;
}

/**
 * Registers the aggregated upstream tools (and their UI resources) on the given
 * MCP server. MCP Switch ships no built-in tools — everything exposed here is a
 * proxy to an upstream MCP server added through the console.
 */
export function registerTools(server: McpServer, client: RegistryClient, ctx: ToolContext) {
  // ───────────── upstream UI resources (MCP Apps widgets) ─────────────
  // Register each upstream server's UI resource so claude.ai / ChatGPT can fetch
  // the widget HTML through the gateway. Reads are forwarded to the origin server
  // via the registry. _meta (e.g. iframe CSP) is relayed through.
  const readRemoteResource = ctx.readRemoteResource;
  const seenResourceUris = new Set<string>();
  for (const rr of ctx.remoteResources ?? []) {
    if (!readRemoteResource) break;
    // A URI can only be registered once; if two servers expose the same uri,
    // first wins (rare — ui:// schemes are usually server-namespaced).
    if (seenResourceUris.has(rr.uri)) continue;
    seenResourceUris.add(rr.uri);
    server.registerResource(
      `rmcp-${rr.serverId}-${rr.uri}`,
      rr.uri,
      {
        title: rr.title ?? rr.name ?? rr.uri,
        description: rr.description ?? `Remote UI resource from ${rr.serverId}.`,
        ...(rr.mimeType ? { mimeType: rr.mimeType } : {}),
        ...(rr.meta ? { _meta: rr.meta } : {})
      },
      async (uri) => {
        const target = typeof uri === "string" ? uri : uri.href;
        const r = await readRemoteResource(rr.serverId, target);
        const contents = r.contents.map((c) => {
          const base = {
            uri: c.uri ?? target,
            ...(c.mimeType ? { mimeType: c.mimeType } : {}),
            ...(c.meta ? { _meta: c.meta as Record<string, unknown> } : {})
          };
          // SDK requires text XOR blob per content item.
          if (typeof c.blob === "string") return { ...base, blob: c.blob };
          return { ...base, text: typeof c.text === "string" ? c.text : "" };
        });
        return { contents };
      }
    );
  }

  // ───────────── proxied upstream tools (source='remote-mcp') ─────────────
  // Pre-filtered by the caller to the agent's visible+enabled set. Each forwards
  // to the registry's full-result proxy. Tool-definition _meta and result _meta are
  // relayed so MCP Apps UIs render.
  for (const rt of ctx.remoteTools) {
    server.registerTool(
      rt.skillId,
      {
        title: rt.title,
        description: rt.description ?? `Remote tool ${rt.toolName} (via ${rt.serverId}).`,
        inputSchema: jsonSchemaToRawShape(rt.inputSchema),
        annotations: { openWorldHint: true },
        ...(rt.meta ? { _meta: rt.meta } : {})
      },
      async (args: Record<string, unknown>) => {
        try {
          const r = await client.proxyRemoteMcpTool(rt.serverId, rt.toolName, args ?? {}, rt.allowWrite);
          const content = Array.isArray(r.content) && r.content.length
            ? r.content
            : [{ type: "text", text: typeof r.structuredContent !== "undefined" ? JSON.stringify(r.structuredContent) : "(no content)" }];
          return {
            content: content as { type: "text"; text: string }[],
            structuredContent: r.structuredContent as Record<string, unknown> | undefined,
            isError: r.isError,
            ...(r.meta ? { _meta: r.meta as Record<string, unknown> } : {})
          };
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Remote tool failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      }
    );
  }
}
