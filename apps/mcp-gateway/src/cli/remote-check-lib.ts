import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike
} from "@modelcontextprotocol/client";

export type RemoteCheckLevel = "pass" | "warning" | "fail" | "skip";

export interface RemoteCheckFinding {
  id: string;
  level: RemoteCheckLevel;
  message: string;
}

export interface AppResourceCheck {
  uri: string;
  linkedTools: string[];
  listed: boolean;
  readable: boolean;
  mimeType: string | null;
  bridge: "mcp-apps" | "openai-only" | "unknown";
}

export interface ProtocolCheck {
  requestedEra: "modern" | "legacy";
  negotiatedEra: "modern" | "legacy" | null;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  toolNames: string[];
  resourceUris: string[];
  appResources: AppResourceCheck[];
}

export interface RemoteGatewayCheckReport {
  endpoint: string;
  checkedAt: string;
  status: "pass" | "warning" | "partial" | "fail";
  authorizationRequired: boolean;
  usedBearerToken: boolean;
  health: Record<string, unknown> | null;
  protectedResourceMetadata: Record<string, unknown> | null;
  modern: ProtocolCheck | null;
  legacy: ProtocolCheck | null;
  findings: RemoteCheckFinding[];
}

export interface RemoteGatewayCheckOptions {
  endpoint: string;
  bearerToken?: string;
  timeoutMs?: number;
  runLegacy?: boolean;
}

const APP_MIME_TYPE = "text/html;profile=mcp-app";

type ToolShape = {
  name: string;
  _meta?: Record<string, unknown>;
};

type ResourceShape = {
  uri: string;
  mimeType?: string;
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeMcpEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP endpoint must use http:// or https://");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
  else if (!url.pathname.endsWith("/mcp")) url.pathname = `${url.pathname}/mcp`;
  return url;
}

function appUris(tool: ToolShape): string[] {
  const meta = tool._meta;
  if (!meta) return [];
  const values = new Set<string>();
  const ui = objectOrNull(meta.ui);
  if (typeof ui?.resourceUri === "string") values.add(ui.resourceUri);
  if (typeof meta["openai/outputTemplate"] === "string") {
    values.add(meta["openai/outputTemplate"] as string);
  }
  return [...values];
}

function bridgeKind(html: string): AppResourceCheck["bridge"] {
  const hasStandardBridge = html.includes("ui/initialize") || html.includes("ui/notifications/");
  if (hasStandardBridge) return "mcp-apps";
  if (html.includes("window.openai")) return "openai-only";
  return "unknown";
}

function timedFetch(timeoutMs: number): FetchLike {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetch(input, { ...init, signal });
  };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return objectOrNull(await response.json());
  } catch {
    return null;
  }
}

async function inspectProtocol(
  endpoint: URL,
  requestedEra: ProtocolCheck["requestedEra"],
  token: string | undefined,
  fetchImpl: FetchLike,
  findings: RemoteCheckFinding[]
): Promise<ProtocolCheck> {
  const client = new Client(
    { name: "mcp-switch-remote-check", version: "0.1.0" },
    requestedEra === "modern"
      ? { versionNegotiation: { mode: "auto" } }
      : undefined
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchImpl,
    ...(token ? { authProvider: { token: async () => token } } : {})
  });

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const resourcesResult = await client.listResources();
    const tools = toolsResult.tools as ToolShape[];
    const resources = resourcesResult.resources as ResourceShape[];
    const listedUris = new Set(resources.map((resource) => resource.uri));
    const linkedTools = new Map<string, string[]>();

    for (const tool of tools) {
      const meta = tool._meta;
      const ui = objectOrNull(meta?.ui);
      const standardUri = typeof ui?.resourceUri === "string" ? ui.resourceUri : null;
      const openAiUri = typeof meta?.["openai/outputTemplate"] === "string"
        ? meta["openai/outputTemplate"] as string
        : null;
      if (standardUri && openAiUri && standardUri !== openAiUri) {
        findings.push({
          id: `${requestedEra}.app-link-mismatch.${tool.name}`,
          level: "fail",
          message: `${tool.name} 的标准 MCP Apps URI 与 OpenAI 兼容 URI 不一致。`
        });
      } else if (!standardUri && openAiUri) {
        findings.push({
          id: `${requestedEra}.openai-only-meta.${tool.name}`,
          level: "warning",
          message: `${tool.name} 只有 openai/outputTemplate，没有标准 ui.resourceUri。`
        });
      }
      for (const uri of appUris(tool)) {
        linkedTools.set(uri, [...(linkedTools.get(uri) ?? []), tool.name]);
      }
    }

    const appResources: AppResourceCheck[] = [];
    for (const [uri, names] of [...linkedTools.entries()].slice(0, 64)) {
      let readable = false;
      let mimeType: string | null = resources.find((resource) => resource.uri === uri)?.mimeType ?? null;
      let bridge: AppResourceCheck["bridge"] = "unknown";
      try {
        const result = await client.readResource({ uri });
        const matching = result.contents.find((content) => content.uri === uri) ?? result.contents[0];
        if (matching) {
          readable = true;
          mimeType = matching.mimeType ?? mimeType;
          if ("text" in matching && typeof matching.text === "string") {
            bridge = bridgeKind(matching.text);
          }
        }
      } catch (error) {
        findings.push({
          id: `${requestedEra}.app-unreadable.${uri}`,
          level: "fail",
          message: `组件资源 ${uri} 无法读取：${error instanceof Error ? error.message : String(error)}`
        });
      }

      if (mimeType !== APP_MIME_TYPE) {
        findings.push({
          id: `${requestedEra}.app-mime.${uri}`,
          level: "fail",
          message: `组件资源 ${uri} 的 MIME 是 ${mimeType ?? "未声明"}，应为 ${APP_MIME_TYPE}。`
        });
      }
      if (bridge === "openai-only") {
        findings.push({
          id: `${requestedEra}.app-openai-only.${uri}`,
          level: "warning",
          message: `组件资源 ${uri} 只检测到 window.openai，跨宿主可移植性有限。`
        });
      } else if (bridge === "unknown") {
        findings.push({
          id: `${requestedEra}.app-bridge-unknown.${uri}`,
          level: "warning",
          message: `组件资源 ${uri} 未检测到标准 MCP Apps bridge。`
        });
      }

      appResources.push({
        uri,
        linkedTools: names,
        listed: listedUris.has(uri),
        readable,
        mimeType,
        bridge
      });
    }
    if (linkedTools.size > 64) {
      findings.push({
        id: `${requestedEra}.app-limit`,
        level: "warning",
        message: `组件资源超过 64 个，本次只读取前 64 个。`
      });
    }

    const server = client.getServerVersion();
    return {
      requestedEra,
      negotiatedEra: client.getProtocolEra() ?? null,
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverName: server?.name ?? null,
      serverVersion: server?.version ?? null,
      toolNames: tools.map((tool) => tool.name).sort(),
      resourceUris: resources.map((resource) => resource.uri).sort(),
      appResources
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function inspectRemoteGateway(
  options: RemoteGatewayCheckOptions
): Promise<RemoteGatewayCheckReport> {
  const endpoint = normalizeMcpEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = timedFetch(timeoutMs);
  const findings: RemoteCheckFinding[] = [];
  const origin = endpoint.origin;
  let health: Record<string, unknown> | null = null;
  let protectedResourceMetadata: Record<string, unknown> | null = null;
  let authorizationRequired = false;

  try {
    const response = await fetchImpl(`${origin}/health`, { headers: { accept: "application/json" } });
    health = await jsonResponse(response);
    if (!response.ok) {
      findings.push({ id: "health.http", level: "fail", message: `/health 返回 HTTP ${response.status}。` });
    } else {
      findings.push({ id: "health.ok", level: "pass", message: "健康检查可达。" });
    }
  } catch (error) {
    findings.push({
      id: "health.network",
      level: "fail",
      message: `/health 无法访问：${error instanceof Error ? error.message : String(error)}`
    });
  }

  const metadataUrl = new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, origin);
  try {
    const response = await fetchImpl(metadataUrl, { headers: { accept: "application/json" } });
    if (response.ok) {
      protectedResourceMetadata = await jsonResponse(response);
      authorizationRequired = true;
      if (protectedResourceMetadata?.resource !== endpoint.toString()) {
        findings.push({
          id: "oauth.resource",
          level: "fail",
          message: `OAuth resource 为 ${String(protectedResourceMetadata?.resource ?? "未声明")}，与 ${endpoint.toString()} 不一致。`
        });
      } else {
        findings.push({ id: "oauth.resource", level: "pass", message: "OAuth resource 与 canonical MCP URL 一致。" });
      }
    } else if (response.status !== 404) {
      findings.push({
        id: "oauth.metadata-http",
        level: "fail",
        message: `Protected Resource Metadata 返回 HTTP ${response.status}。`
      });
      await response.body?.cancel();
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    findings.push({
      id: "oauth.metadata-network",
      level: "fail",
      message: `Protected Resource Metadata 无法访问：${error instanceof Error ? error.message : String(error)}`
    });
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "auth-probe", method: "ping" })
    });
    if (response.status === 401) {
      authorizationRequired = true;
      const challenge = response.headers.get("www-authenticate") ?? "";
      if (!challenge.toLowerCase().startsWith("bearer ") || !challenge.includes("resource_metadata=")) {
        findings.push({
          id: "oauth.challenge",
          level: "fail",
          message: "401 响应缺少带 resource_metadata 的 Bearer challenge。"
        });
      } else {
        findings.push({ id: "oauth.challenge", level: "pass", message: "未授权请求返回标准 Bearer challenge。" });
      }
    } else if (response.status >= 500) {
      findings.push({ id: "mcp.public-probe", level: "fail", message: `/mcp 探针返回 HTTP ${response.status}。` });
    }
    await response.body?.cancel();
  } catch (error) {
    findings.push({
      id: "mcp.public-probe",
      level: "fail",
      message: `/mcp 探针失败：${error instanceof Error ? error.message : String(error)}`
    });
  }

  let modern: ProtocolCheck | null = null;
  let legacy: ProtocolCheck | null = null;
  const token = options.bearerToken?.trim() || undefined;
  if (authorizationRequired && !token) {
    findings.push({
      id: "protocol.auth-skipped",
      level: "skip",
      message: "网关需要 OAuth；未提供 MCP_CHECK_TOKEN，因此跳过协议、目录和组件读取。"
    });
  } else {
    try {
      modern = await inspectProtocol(endpoint, "modern", token, fetchImpl, findings);
      if (modern.negotiatedEra !== "modern") {
        findings.push({
          id: "protocol.modern-era",
          level: "fail",
          message: `自动协商得到 ${modern.negotiatedEra ?? "未知"}，没有进入 MCP 2026 modern era。`
        });
      } else {
        findings.push({
          id: "protocol.modern-era",
          level: "pass",
          message: `MCP 2026 协商成功（${modern.protocolVersion ?? "版本未知"}）。`
        });
      }
    } catch (error) {
      findings.push({
        id: "protocol.modern",
        level: "fail",
        message: `MCP 2026 检查失败：${error instanceof Error ? error.message : String(error)}`
      });
    }

    if (options.runLegacy !== false) {
      try {
        legacy = await inspectProtocol(endpoint, "legacy", token, fetchImpl, findings);
        if (legacy.negotiatedEra !== "legacy") {
          findings.push({
            id: "protocol.legacy-era",
            level: "fail",
            message: `旧客户端得到 ${legacy.negotiatedEra ?? "未知"}，没有进入 legacy era。`
          });
        } else {
          findings.push({
            id: "protocol.legacy-era",
            level: "pass",
            message: `MCP 2025 兼容连接成功（${legacy.protocolVersion ?? "版本未知"}）。`
          });
        }
      } catch (error) {
        findings.push({
          id: "protocol.legacy",
          level: "fail",
          message: `MCP 2025 兼容检查失败：${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  if (modern && legacy) {
    if (!sameValues(modern.toolNames, legacy.toolNames)) {
      findings.push({ id: "protocol.tool-parity", level: "fail", message: "新旧协议看到的工具目录不一致。" });
    } else {
      findings.push({ id: "protocol.tool-parity", level: "pass", message: "新旧协议的工具目录一致。" });
    }
    if (!sameValues(modern.resourceUris, legacy.resourceUris)) {
      findings.push({ id: "protocol.resource-parity", level: "fail", message: "新旧协议看到的资源目录不一致。" });
    } else {
      findings.push({ id: "protocol.resource-parity", level: "pass", message: "新旧协议的资源目录一致。" });
    }
  }

  const hasFailure = findings.some((finding) => finding.level === "fail");
  const hasSkip = findings.some((finding) => finding.level === "skip");
  const hasWarning = findings.some((finding) => finding.level === "warning");
  const status: RemoteGatewayCheckReport["status"] = hasFailure
    ? "fail"
    : hasSkip ? "partial" : hasWarning ? "warning" : "pass";

  return {
    endpoint: endpoint.toString(),
    checkedAt: new Date().toISOString(),
    status,
    authorizationRequired,
    usedBearerToken: Boolean(token),
    health,
    protectedResourceMetadata,
    modern,
    legacy,
    findings
  };
}
