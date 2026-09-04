import { createHash } from "node:crypto";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.length > 0 ? safe : "unnamed";
}

/**
 * Preserve the historical name whenever it is already legal. Existing agents
 * and console toggles therefore keep working, while arbitrary upstream names
 * are made deterministic and MCP-2026 compliant.
 */
export function proxyToolName(serverId: string, toolName: string): string {
  const legacy = `rmcp__${serverId}__${toolName}`;
  if (VALID_TOOL_NAME.test(legacy)) return legacy;

  const sanitized = `rmcp__${safeSegment(serverId)}__${safeSegment(toolName)}`;
  if (VALID_TOOL_NAME.test(sanitized)) return sanitized;

  const digest = createHash("sha256")
    .update(`${serverId}\0${toolName}`)
    .digest("hex")
    .slice(0, 12);
  const suffix = `__${digest}`;
  return `${sanitized.slice(0, 128 - suffix.length)}${suffix}`;
}

/**
 * ui:// URIs are commonly reused by unrelated servers (for example
 * ui://widget/index.html). A gateway has one resource namespace, so expose a
 * stable public URI and retain the original URI only for the upstream read.
 */
export function proxyResourceUri(serverId: string, upstreamUri: string): string {
  const encoded = Buffer.from(upstreamUri, "utf8").toString("base64url");
  return `ui://mcp-switch/${safeSegment(serverId)}/${encoded}`;
}

export function resourceUrisFromMeta(
  meta: Record<string, unknown> | null | undefined
): string[] {
  if (!meta) return [];
  const out = new Set<string>();
  const ui = meta.ui;
  if (ui && typeof ui === "object") {
    const uri = (ui as { resourceUri?: unknown }).resourceUri;
    if (typeof uri === "string") out.add(uri);
  }
  const openAiTemplate = meta["openai/outputTemplate"];
  if (typeof openAiTemplate === "string") out.add(openAiTemplate);
  return [...out];
}

/** Add both the open MCP Apps key and ChatGPT's compatibility alias. */
export function rewriteAppToolMeta(
  meta: Record<string, unknown> | null | undefined,
  serverId: string
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const originalUris = resourceUrisFromMeta(meta);
  if (originalUris.length === 0) return { ...meta };

  const publicUri = proxyResourceUri(serverId, originalUris[0]!);
  const ui = meta.ui && typeof meta.ui === "object"
    ? { ...(meta.ui as Record<string, unknown>), resourceUri: publicUri }
    : { resourceUri: publicUri };
  return {
    ...meta,
    ui,
    "openai/outputTemplate": publicUri
  };
}

/**
 * Bridge older ChatGPT Apps metadata to the open MCP Apps spelling while
 * retaining the old keys for clients that still consume them.
 */
export function normalizeAppResourceMeta(
  meta: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const ui = meta.ui && typeof meta.ui === "object"
    ? { ...(meta.ui as Record<string, unknown>) }
    : {};

  const oldCsp = meta["openai/widgetCSP"];
  if (!ui.csp && oldCsp && typeof oldCsp === "object") {
    const csp = oldCsp as Record<string, unknown>;
    ui.csp = {
      ...(Array.isArray(csp.connect_domains) ? { connectDomains: csp.connect_domains } : {}),
      ...(Array.isArray(csp.resource_domains) ? { resourceDomains: csp.resource_domains } : {}),
      ...(Array.isArray(csp.frame_domains) ? { frameDomains: csp.frame_domains } : {})
    };
  }
  if (ui.description === undefined && typeof meta["openai/widgetDescription"] === "string") {
    ui.description = meta["openai/widgetDescription"];
  }
  if (ui.prefersBorder === undefined && typeof meta["openai/widgetPrefersBorder"] === "boolean") {
    ui.prefersBorder = meta["openai/widgetPrefersBorder"];
  }
  if (ui.domain === undefined && typeof meta["openai/widgetDomain"] === "string") {
    ui.domain = meta["openai/widgetDomain"];
  }

  return Object.keys(ui).length > 0 ? { ...meta, ui } : { ...meta };
}

export function normalizeAppMimeType(
  mimeType: string | null | undefined,
  isLinkedAppResource: boolean
): string | undefined {
  if (!isLinkedAppResource) return mimeType ?? undefined;
  if (!mimeType || mimeType === "text/html" || mimeType === "text/html+skybridge") {
    return MCP_APP_MIME_TYPE;
  }
  return mimeType;
}
