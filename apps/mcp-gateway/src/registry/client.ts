import { z } from "zod";
import { connectorSchema, connectorSummarySchema } from "@mcp-switch/schemas";
import type { RemoteMcpRegistry } from "./remote-mcp.js";
import type { AuthStore } from "../auth/store.js";

const addServerSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-z0-9-]+$/, "id: lowercase/digits/hyphen only"),
  name: z.string().trim().min(1),
  // HTTP servers need url; stdio (locally hosted) servers use command/args/env.
  transport: z.enum(["http", "stdio"]).default("http"),
  url: z.string().url().optional(),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  description: z.string().trim().min(1).optional(),
  bearerTokenEnv: z.string().trim().min(1).optional(),
  bearerToken: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  oauthClientId: z.string().trim().min(1).optional(),
  oauthClientSecret: z.string().trim().min(1).optional()
}).superRefine((v, ctx) => {
  if (v.transport === "stdio") {
    if (!v.command) ctx.addIssue({ code: "custom", message: "stdio server needs a command" });
  } else if (!v.url) {
    ctx.addIssue({ code: "custom", message: "http server needs a url" });
  }
});

/**
 * In-process façade over the upstream-MCP registry + AuthStore. Same method surface
 * as the old HTTP backend client, but calls everything in-process (no network hop).
 */
export function createRegistryClient(registry: RemoteMcpRegistry, store: AuthStore) {
  return {
    async getConnectorStatus() {
      const connectors = connectorSchema.array().parse(await registry.toConnectors());
      return {
        summary: connectorSummarySchema.parse({
          total: connectors.length,
          online: connectors.filter((c) => c.status === "online").length,
          degraded: connectors.filter((c) => c.status === "degraded").length,
          offline: connectors.filter((c) => c.status === "offline").length
        }),
        connectors
      };
    },

    async listRemoteMcpServers() {
      return registry.listServers();
    },

    async addRemoteServer(config: Record<string, unknown>) {
      const parsed = addServerSchema.safeParse(config);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      const d = parsed.data;
      // stdio has no real URL — synthesise `stdio://command args` for display/NOT NULL.
      const url = d.transport === "stdio"
        ? `stdio://${[d.command, ...(d.args ?? [])].join(" ")}`.slice(0, 240)
        : d.url!;
      store.upsertRemoteServerConfig({ ...d, url, description: d.description ?? d.name });
      return { ok: true as const, id: d.id };
    },

    async deleteRemoteServer(id: string) {
      const deleted = store.deleteRemoteServerConfig(id);
      return { ok: true as const, deleted };
    },

    async startRemoteOauth(serverId: string, redirectUri: string) {
      return registry.startOauth(serverId, redirectUri);
    },

    async finishRemoteOauth(code: string, state: string) {
      const serverId = store.findRemoteServerIdByOauthState(state);
      if (!serverId) throw new Error("unknown or expired OAuth state");
      await registry.finishOauth(serverId, code, state);
      return { ok: true as const, serverId };
    },

    async proxyRemoteMcpTool(serverId: string, toolName: string, args: Record<string, unknown>, allowWrite: boolean) {
      return registry.invokeToolRaw(serverId, toolName, { arguments: args ?? {}, allowWrite });
    },

    async readRemoteResource(serverId: string, uri: string) {
      return registry.readResource(serverId, uri);
    }
  };
}

export type RegistryClient = ReturnType<typeof createRegistryClient>;
