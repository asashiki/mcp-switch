import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type Icon,
  type JsonSchemaType,
  type ToolAnnotations,
  type ToolExecution,
  type jsonSchemaValidator
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { RegistryClient } from "./registry/client.js";
import {
  normalizeAppMimeType,
  normalizeAppResourceMeta,
  proxyResourceUri,
  resourceUrisFromMeta,
  rewriteAppToolMeta
} from "./registry/proxy-metadata.js";

export interface RemoteToolDescriptor {
  skillId: string;
  title: string;
  description: string | null;
  serverId: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
  icons?: Array<Record<string, unknown>> | null;
  execution?: Record<string, unknown> | null;
  /** Whether invoking the upstream tool is expected to be side-effect free. */
  readOnly: boolean;
  allowWrite: boolean;
  /** Tool-definition _meta (MCP Apps ui.resourceUri / openai outputTemplate). */
  meta?: Record<string, unknown> | null;
}

export interface RemoteResourceDescriptor {
  serverId: string;
  /** URI used when reading from the upstream server. */
  uri: string;
  name: string | null;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  meta: Record<string, unknown> | null;
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.find((item): item is string => typeof item === "string" && item !== "null");
  return undefined;
}

/**
 * Models occasionally serialize typed arguments as strings. Coerce only when
 * the schema has one unambiguous direct type, then let the SDK's full JSON
 * Schema validator enforce every constraint ($ref/oneOf/pattern/ranges, etc.).
 */
function coerceForSchema(schema: Record<string, unknown>, input: unknown): unknown {
  const type = schemaType(schema);
  if ((type === "number" || type === "integer") && typeof input === "string" && input.trim() !== "") {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : input;
  }
  if (type === "boolean" && typeof input === "string") {
    if (input === "true") return true;
    if (input === "false") return false;
  }
  if ((type === "array" || type === "object") && typeof input === "string") {
    try { return coerceForSchema(schema, JSON.parse(input)); } catch { return input; }
  }
  if (type === "array" && Array.isArray(input)) {
    const items = schema.items;
    return items && typeof items === "object" && !Array.isArray(items)
      ? input.map((item) => coerceForSchema(items as Record<string, unknown>, item))
      : input;
  }
  if (type === "object" && input && typeof input === "object" && !Array.isArray(input)) {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown>
      : {};
    const out = { ...(input as Record<string, unknown>) };
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in out && propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
        out[key] = coerceForSchema(propertySchema as Record<string, unknown>, out[key]);
      }
    }
    return out;
  }
  return input;
}

const strictJsonSchemaValidator = new AjvJsonSchemaValidator();
const coercingJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    const validate = strictJsonSchemaValidator.getValidator<T>(schema);
    return (input: unknown) => validate(coerceForSchema(schema as Record<string, unknown>, input));
  }
};

export interface ToolContext {
  /** Flattened remote tools to re-expose as top-level proxy tools. */
  remoteTools: RemoteToolDescriptor[];
  /** UI resources exposed by upstream servers (MCP Apps widgets), for passthrough. */
  remoteResources?: RemoteResourceDescriptor[];
  readRemoteResource?: (serverId: string, uri: string) => Promise<{
    contents: Array<{
      uri: string;
      mimeType?: string | null;
      text?: string | null;
      blob?: string | null;
      meta?: unknown;
    }>;
  }>;
}

/** Register protocol-faithful upstream tools and collision-safe MCP Apps resources. */
export function registerTools(server: McpServer, client: RegistryClient, ctx: ToolContext) {
  const readRemoteResource = ctx.readRemoteResource;
  const linkedAppResources = new Set(
    ctx.remoteTools.flatMap((tool) => resourceUrisFromMeta(tool.meta))
  );

  for (const rr of ctx.remoteResources ?? []) {
    if (!readRemoteResource) break;
    const publicUri = proxyResourceUri(rr.serverId, rr.uri);
    const linkedApp = linkedAppResources.has(rr.uri);
    const mimeType = normalizeAppMimeType(rr.mimeType, linkedApp);
    const resourceMeta = normalizeAppResourceMeta(rr.meta);
    server.registerResource(
      `rmcp-resource-${rr.serverId}-${Buffer.from(rr.uri).toString("base64url")}`,
      publicUri,
      {
        title: rr.title ?? rr.name ?? rr.uri,
        description: rr.description ?? `Remote UI resource from ${rr.serverId}.`,
        ...(mimeType ? { mimeType } : {}),
        ...(resourceMeta ? { _meta: resourceMeta } : {})
      },
      async () => {
        const result = await readRemoteResource(rr.serverId, rr.uri);
        const contents = result.contents.map((content) => {
          const contentUri = proxyResourceUri(rr.serverId, content.uri || rr.uri);
          const contentMime = normalizeAppMimeType(content.mimeType ?? rr.mimeType, linkedApp);
          const contentMeta = normalizeAppResourceMeta(
            content.meta && typeof content.meta === "object"
              ? content.meta as Record<string, unknown>
              : rr.meta
          );
          const base = {
            uri: contentUri,
            ...(contentMime ? { mimeType: contentMime } : {}),
            ...(contentMeta ? { _meta: contentMeta } : {})
          };
          if (typeof content.blob === "string") return { ...base, blob: content.blob };
          return { ...base, text: typeof content.text === "string" ? content.text : "" };
        });
        return { contents };
      }
    );
  }

  for (const rt of ctx.remoteTools) {
    const rewrittenMeta = rewriteAppToolMeta(rt.meta, rt.serverId);
    const registered = server.registerTool(
      rt.skillId,
      {
        title: rt.title,
        description: rt.description ?? `Remote tool ${rt.toolName} (via ${rt.serverId}).`,
        inputSchema: fromJsonSchema(rt.inputSchema as JsonSchemaType, coercingJsonSchemaValidator),
        ...(rt.outputSchema
          ? { outputSchema: fromJsonSchema(rt.outputSchema as JsonSchemaType) }
          : {}),
        ...(rt.annotations ? { annotations: rt.annotations as ToolAnnotations } : {}),
        ...(rt.icons ? { icons: rt.icons as Icon[] } : {}),
        ...(rewrittenMeta ? { _meta: rewrittenMeta } : {})
      },
      async (args: unknown) => {
        try {
          const input = args && typeof args === "object" && !Array.isArray(args)
            ? args as Record<string, unknown>
            : {};
          const result = await client.proxyRemoteMcpTool(
            rt.serverId,
            rt.toolName,
            input,
            rt.allowWrite
          );
          const content = Array.isArray(result.content) && result.content.length
            ? result.content
            : [{
                type: "text",
                text: typeof result.structuredContent !== "undefined"
                  ? JSON.stringify(result.structuredContent)
                  : "(no content)"
              }];
          const resultMeta = rewriteAppToolMeta(
            result.meta && typeof result.meta === "object"
              ? result.meta as Record<string, unknown>
              : undefined,
            rt.serverId
          );
          return {
            content: content as CallToolResult["content"],
            structuredContent: result.structuredContent as Record<string, unknown> | undefined,
            isError: result.isError,
            ...(resultMeta ? { _meta: resultMeta } : {})
          };
        } catch (error) {
          return {
            content: [{
              type: "text" as const,
              text: `Remote tool failed: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    if (rt.execution) registered.execution = rt.execution as ToolExecution;
  }
}
