import { z } from "zod";

export const schemaVersion = "2026-04-m2";

export const serviceKindSchema = z.enum([
  "mcp-gateway"
]);

export type ServiceKind = z.infer<typeof serviceKindSchema>;

export const exposureLevelSchema = z.enum([
  "public",
  "private-operational",
  "private-personal",
  "mcp-exposed"
]);

export const serviceManifestSchema = z.object({
  id: serviceKindSchema,
  name: z.string().min(1),
  port: z.number().int().positive(),
  exposure: exposureLevelSchema,
  description: z.string().min(1)
});

export type ServiceManifest = z.infer<typeof serviceManifestSchema>;

export const serviceHealthSchema = z.object({
  app: serviceManifestSchema,
  schemaVersion: z.literal(schemaVersion),
  environment: z.enum(["development", "test", "production"]),
  startedAt: z.string().datetime(),
  status: z.enum(["ok"]),
  uptimeSeconds: z.number().nonnegative()
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const connectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(["online", "degraded", "offline"]),
  lastSeenAt: z.string().datetime(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  capabilities: z.array(z.string().min(1)).max(12),
  exposureLevel: exposureLevelSchema
});

export type Connector = z.infer<typeof connectorSchema>;

export const connectorSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  online: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative()
});

export type ConnectorSummary = z.infer<typeof connectorSummarySchema>;

export const remoteMcpAuthModeSchema = z.enum(["none", "bearer", "bearer-env", "oauth"]);

export type RemoteMcpAuthMode = z.infer<typeof remoteMcpAuthModeSchema>;

export const remoteMcpToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  readOnlyHint: z.boolean(),
  requiredArguments: z.array(z.string().min(1)).max(24),
  inputSchema: z.record(z.string(), z.unknown()),
  /** Tool-definition _meta (e.g. MCP Apps ui.resourceUri / openai outputTemplate). */
  meta: z.record(z.string(), z.unknown()).nullable().optional()
});

export type RemoteMcpTool = z.infer<typeof remoteMcpToolSchema>;

/** A UI/template resource exposed by a remote MCP server (MCP Apps widget, etc.). */
export const remoteMcpResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
  /** Resource _meta (e.g. iframe CSP for MCP Apps). */
  meta: z.record(z.string(), z.unknown()).nullable().optional()
});

export type RemoteMcpResource = z.infer<typeof remoteMcpResourceSchema>;

export const remoteMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // http 服务器是真实 URL；stdio（本地托管）服务器没有 URL，用 `stdio://<command>` 占位显示。
  url: z.string().min(1),
  description: z.string().min(1),
  /** http=远程 URL 中转；stdio=本机拉起子进程托管。缺省视为 http。 */
  transport: z.enum(["http", "stdio"]).optional(),
  /** stdio 托管的命令/参数（用于控制台「查看配置」回显）。 */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** 已配置的 env / header 键名（仅键名，密钥值不外泄）。 */
  envKeys: z.array(z.string()).optional(),
  headerKeys: z.array(z.string()).optional(),
  authMode: remoteMcpAuthModeSchema,
  status: z.enum(["online", "degraded", "offline"]),
  /** 服务器回了 401/需要 OAuth 授权（前端据此显示「去授权」按钮）。 */
  needsAuth: z.boolean().optional(),
  /** OAuth 服务器是否已持有 token。 */
  oauthAuthorized: z.boolean().optional(),
  lastSeenAt: z.string().datetime(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  toolCount: z.number().int().nonnegative(),
  readOnlyToolCount: z.number().int().nonnegative(),
  writeToolCount: z.number().int().nonnegative(),
  tools: z.array(remoteMcpToolSchema).max(32),
  /** UI/template resources the server exposes (for MCP Apps passthrough). */
  resources: z.array(remoteMcpResourceSchema).max(32).optional()
});

export type RemoteMcpServer = z.infer<typeof remoteMcpServerSchema>;

/** Contents returned by reading a remote resource (forwarded by the gateway). */
export const remoteMcpResourceContentsSchema = z.object({
  contents: z.array(z.object({
    uri: z.string(),
    mimeType: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    blob: z.string().nullable().optional(),
    meta: z.record(z.string(), z.unknown()).nullable().optional()
  }))
});

export type RemoteMcpResourceContents = z.infer<typeof remoteMcpResourceContentsSchema>;

export const remoteMcpToolInvokeInputSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  allowWrite: z.boolean().default(false)
});

export type RemoteMcpToolInvokeInput = z.infer<
  typeof remoteMcpToolInvokeInputSchema
>;

export const remoteMcpToolInvokeResultSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  ok: z.boolean(),
  summary: z.string().min(1),
  preview: z.string().nullable(),
  executedAt: z.string().datetime()
});

export type RemoteMcpToolInvokeResult = z.infer<
  typeof remoteMcpToolInvokeResultSchema
>;

export const mcpToolCatalogItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  readOnlyHint: z.boolean()
});

export const mcpToolCatalogSchema = z.array(mcpToolCatalogItemSchema).max(64);

export type McpToolCatalogItem = z.infer<typeof mcpToolCatalogItemSchema>;


export function createServiceHealth(
  app: ServiceManifest,
  environment: "development" | "test" | "production",
  startedAt: Date,
  now = new Date()
): ServiceHealth {
  return serviceHealthSchema.parse({
    app,
    schemaVersion,
    environment,
    startedAt: startedAt.toISOString(),
    status: "ok",
    uptimeSeconds: Math.max(
      0,
      Math.round((now.getTime() - startedAt.getTime()) / 1000)
    )
  });
}
