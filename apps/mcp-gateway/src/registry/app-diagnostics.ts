import {
  mcpAppDiagnosticsSchema,
  type McpAppDiagnostics,
  type RemoteMcpResource,
  type RemoteMcpResourceContents,
  type RemoteMcpServer,
  type RemoteMcpTool
} from "@mcp-switch/schemas";
import {
  MCP_APP_MIME_TYPE,
  normalizeAppMimeType,
  normalizeAppResourceMeta,
  proxyResourceUri,
  resourceUrisFromMeta
} from "./proxy-metadata.js";

type Check = McpAppDiagnostics["checks"][number];
type Csp = McpAppDiagnostics["components"][number]["csp"];

const EMPTY_CSP: Csp = { connectDomains: [], resourceDomains: [], frameDomains: [] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function cspFromMeta(meta: Record<string, unknown> | null | undefined): Csp {
  const normalized = normalizeAppResourceMeta(meta);
  const ui = record(normalized?.ui);
  const csp = record(ui?.csp);
  return csp ? {
    connectDomains: strings(csp.connectDomains),
    resourceDomains: strings(csp.resourceDomains),
    frameDomains: strings(csp.frameDomains)
  } : { ...EMPTY_CSP };
}

function dedicatedDomainFromMeta(meta: Record<string, unknown> | null | undefined): string | null {
  const normalized = normalizeAppResourceMeta(meta);
  const ui = record(normalized?.ui);
  return typeof ui?.domain === "string" ? ui.domain : null;
}

function validHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch {
    return false;
  }
}

function validateCsp(csp: Csp, toolName: string, resourceUri: string): Check[] {
  const checks: Check[] = [];
  for (const [kind, domains] of Object.entries(csp) as Array<[keyof Csp, string[]]>) {
    for (const domain of domains) {
      const wildcard = domain.includes("*");
      if (wildcard || !validHttpsOrigin(domain)) {
        checks.push({
          severity: wildcard ? "warning" : "error",
          code: wildcard ? "csp-wildcard" : "csp-invalid-origin",
          message: `${kind} contains ${wildcard ? "a wildcard" : "a non-HTTPS or non-origin value"}: ${domain}`,
          toolName,
          resourceUri
        });
      }
    }
  }
  return checks;
}

function resolveLocalRef(root: Record<string, unknown>, value: unknown): unknown {
  const candidate = record(value);
  const ref = typeof candidate?.$ref === "string" ? candidate.$ref : null;
  if (!ref?.startsWith("#/")) return value;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    current = record(current)?.[key];
  }
  return current ?? value;
}

function sampleFromSchema(
  root: Record<string, unknown>,
  rawSchema: unknown,
  propertyName = "value",
  depth = 0
): unknown {
  if (depth > 6) return null;
  const schema = record(resolveLocalRef(root, rawSchema));
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const branch = Array.isArray(schema.oneOf) ? schema.oneOf[0]
    : Array.isArray(schema.anyOf) ? schema.anyOf[0]
      : undefined;
  if (branch !== undefined) return sampleFromSchema(root, branch, propertyName, depth + 1);

  const properties = record(schema.properties);
  if (schema.type === "object" || properties) {
    const output: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties ?? {}).slice(0, 24)) {
      output[name] = sampleFromSchema(root, child, name, depth + 1);
    }
    return output;
  }
  if (schema.type === "array") {
    return [sampleFromSchema(root, schema.items, propertyName.replace(/s$/, ""), depth + 1)];
  }
  if (schema.type === "integer" || schema.type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  if (schema.type === "string" || !schema.type) {
    const lower = propertyName.toLowerCase();
    if (schema.format === "uri" || schema.format === "url" || lower.endsWith("url")) return "https://example.com/resource";
    if (lower.includes("artist")) return "Example artist";
    if (lower.includes("title") || lower.includes("name")) return "Example title";
    if (lower.includes("id")) return "example-id";
    return "example";
  }
  return null;
}

export function appHtmlFromContents(
  contents: RemoteMcpResourceContents,
  preferredUri: string,
  maxBytes = 512 * 1024
): { html: string; mimeType: string | null; meta: Record<string, unknown> | null } {
  const content = contents.contents.find((item) => item.uri === preferredUri) ?? contents.contents[0];
  if (!content) throw new Error(`Resource ${preferredUri} returned no contents.`);
  let html = content.text ?? null;
  if (!html && content.blob) {
    if (content.blob.length > Math.ceil(maxBytes * 4 / 3) + 16) {
      throw new Error(`App resource ${preferredUri} exceeds ${maxBytes} bytes.`);
    }
    html = Buffer.from(content.blob, "base64").toString("utf8");
  }
  if (html === null) throw new Error(`App resource ${preferredUri} has no HTML text or blob.`);
  if (Buffer.byteLength(html, "utf8") > maxBytes) {
    throw new Error(`App resource ${preferredUri} exceeds ${maxBytes} bytes.`);
  }
  return { html, mimeType: content.mimeType ?? null, meta: content.meta ?? null };
}

export async function diagnoseMcpApps(
  server: RemoteMcpServer,
  readResource: (uri: string) => Promise<RemoteMcpResourceContents>
): Promise<McpAppDiagnostics> {
  const resources = server.resources ?? [];
  const resourceByUri = new Map(resources.map((resource) => [resource.uri, resource]));
  const reads = new Map<string, Promise<RemoteMcpResourceContents>>();
  const readOnce = (uri: string) => {
    let pending = reads.get(uri);
    if (!pending) {
      pending = readResource(uri);
      reads.set(uri, pending);
    }
    return pending;
  };
  // Resource reads can involve network or stdio round trips. Warm the unique
  // linked set with bounded concurrency so App Lab does not take one timeout
  // per component, while also avoiding a 512-request burst at an upstream.
  const linkedUris = [...new Set(server.tools.flatMap((tool) => resourceUrisFromMeta(tool.meta ?? null)))]
    .filter((uri) => resourceByUri.has(uri));
  let nextUri = 0;
  await Promise.all(Array.from({ length: Math.min(4, linkedUris.length) }, async () => {
    for (;;) {
      const uri = linkedUris[nextUri++];
      if (!uri) return;
      await readOnce(uri).catch(() => undefined);
    }
  }));
  const checks: Check[] = [];
  const components: McpAppDiagnostics["components"] = [];

  for (const tool of server.tools) {
    const meta = tool.meta ?? null;
    const ui = record(meta?.ui);
    const standardUri = typeof ui?.resourceUri === "string" ? ui.resourceUri : null;
    const aliasUri = typeof meta?.["openai/outputTemplate"] === "string"
      ? meta["openai/outputTemplate"] as string
      : null;
    const linkedUris = resourceUrisFromMeta(meta);
    if (linkedUris.length === 0) continue;
    const uri = standardUri ?? aliasUri ?? linkedUris[0]!;
    const componentChecks: Check[] = [];
    const add = (check: Omit<Check, "toolName" | "resourceUri">) => componentChecks.push({
      ...check,
      toolName: tool.name,
      resourceUri: uri
    });

    if (standardUri && aliasUri && standardUri !== aliasUri) {
      add({ severity: "error", code: "tool-uri-mismatch", message: "ui.resourceUri and openai/outputTemplate point to different resources." });
    } else if (!standardUri && aliasUri) {
      add({ severity: "warning", code: "tool-openai-only", message: "Tool uses only openai/outputTemplate; Switch will add the portable ui.resourceUri key." });
    } else if (standardUri && !aliasUri) {
      add({ severity: "info", code: "tool-standard-only", message: "Portable ui.resourceUri is present; Switch adds the ChatGPT compatibility alias." });
    } else {
      add({ severity: "pass", code: "tool-link-ok", message: "Tool publishes matching standard and ChatGPT component links." });
    }

    const resource = resourceByUri.get(uri) ?? null;
    let resourceMeta = resource?.meta ?? null;
    let mimeType = resource?.mimeType ?? null;
    let normalizedMimeType = normalizeAppMimeType(mimeType, true) ?? null;
    let bridge: McpAppDiagnostics["components"][number]["bridge"] = "unreadable";
    let htmlBytes: number | null = null;

    if (!resource) {
      add({ severity: "error", code: "resource-missing", message: "Linked ui:// resource is missing from resources/list." });
    } else {
      try {
        const content = appHtmlFromContents(await readOnce(uri), uri);
        resourceMeta = { ...(resource.meta ?? {}), ...(content.meta ?? {}) };
        mimeType = content.mimeType ?? mimeType;
        normalizedMimeType = normalizeAppMimeType(mimeType, true) ?? null;
        htmlBytes = Buffer.byteLength(content.html, "utf8");
        const standardBridge = /ui\/initialize|ui\/notifications\/initialized/.test(content.html);
        const openAiBridge = /window\.openai|openai:set_globals/.test(content.html);
        bridge = standardBridge ? "mcp-apps" : openAiBridge ? "openai-only" : "static-or-unknown";
        if (standardBridge) {
          add({ severity: "pass", code: "bridge-standard", message: "HTML contains the portable MCP Apps ui/* bridge." });
        } else if (openAiBridge) {
          add({ severity: "warning", code: "bridge-openai-only", message: "HTML appears to depend on window.openai without the portable ui/* bridge." });
        } else {
          add({ severity: "info", code: "bridge-not-detected", message: "No runtime bridge was detected; this is fine only for a static component." });
        }
      } catch (error) {
        add({ severity: "error", code: "resource-unreadable", message: error instanceof Error ? error.message : "App resource could not be read." });
      }

      if (mimeType === MCP_APP_MIME_TYPE) {
        add({ severity: "pass", code: "mime-current", message: `Resource uses ${MCP_APP_MIME_TYPE}.` });
      } else if (!mimeType || mimeType === "text/html" || mimeType === "text/html+skybridge") {
        add({ severity: "warning", code: "mime-legacy", message: `Resource MIME ${mimeType ?? "is missing"}; Switch normalizes it to ${MCP_APP_MIME_TYPE}.` });
      } else {
        add({ severity: "error", code: "mime-invalid", message: `Linked component has incompatible MIME ${mimeType}.` });
      }
    }

    const normalizedResourceMeta = normalizeAppResourceMeta(resourceMeta);
    const normalizedUi = record(normalizedResourceMeta?.ui);
    const hasOpenAiResourceKeys = Boolean(resourceMeta && Object.keys(resourceMeta).some((key) => key.startsWith("openai/")));
    if (!record(resourceMeta?.ui) && hasOpenAiResourceKeys) {
      add({ severity: "warning", code: "resource-openai-only", message: "Resource metadata uses only openai/* aliases; Switch adds the standard ui object." });
    } else if (normalizedUi) {
      add({ severity: "pass", code: "resource-ui-meta", message: "Resource publishes portable ui metadata." });
    }

    const csp = cspFromMeta(resourceMeta);
    componentChecks.push(...validateCsp(csp, tool.name, uri));
    const dedicatedDomain = dedicatedDomainFromMeta(resourceMeta);
    if (dedicatedDomain) {
      add(validHttpsOrigin(dedicatedDomain)
        ? { severity: "info", code: "dedicated-domain", message: `Dedicated widget origin declared: ${dedicatedDomain}. Verify it is publicly reachable before deployment.` }
        : { severity: "error", code: "dedicated-domain-invalid", message: `Dedicated widget domain is not an exact HTTPS origin: ${dedicatedDomain}.` });
    }

    const hasOutputSchema = Boolean(tool.outputSchema && Object.keys(tool.outputSchema).length > 0);
    add(hasOutputSchema
      ? { severity: "pass", code: "output-schema", message: "Tool publishes outputSchema for portable structured rendering." }
      : { severity: "warning", code: "output-schema-missing", message: "UI tool has no outputSchema; hosts and App Lab cannot validate structuredContent." });

    checks.push(...componentChecks);
    components.push({
      toolName: tool.name,
      toolTitle: tool.title,
      upstreamUri: uri,
      proxyUri: proxyResourceUri(server.id, uri),
      resourceFound: Boolean(resource),
      mimeType,
      normalizedMimeType,
      bridge,
      htmlBytes,
      dedicatedDomain,
      csp,
      hasOutputSchema,
      sampleStructuredContent: hasOutputSchema
        ? sampleFromSchema(tool.outputSchema!, tool.outputSchema!) ?? null
        : null,
      checks: componentChecks
    });
  }

  const linked = new Set(components.map((component) => component.upstreamUri));
  const appResources = resources.filter((resource) =>
    linked.has(resource.uri) || resource.mimeType === MCP_APP_MIME_TYPE || resource.mimeType === "text/html+skybridge"
  );
  for (const orphan of appResources.filter((resource) => !linked.has(resource.uri))) {
    checks.push({
      severity: "warning",
      code: "orphan-app-resource",
      message: "App-like resource is not linked from any tool definition.",
      resourceUri: orphan.uri
    });
  }
  if (components.length === 0) {
    checks.push({ severity: "info", code: "no-app-tools", message: "No tools link an MCP Apps component." });
  } else {
    checks.push({
      severity: "pass",
      code: "namespace-isolation",
      message: "Switch assigns every upstream ui:// resource a server-scoped proxy URI to prevent cross-server collisions."
    });
  }

  const status = components.length === 0 ? "none"
    : checks.some((check) => check.severity === "error") ? "error"
      : checks.some((check) => check.severity === "warning") ? "warning"
        : "pass";
  return mcpAppDiagnosticsSchema.parse({
    serverId: server.id,
    generatedAt: new Date().toISOString(),
    status,
    uiToolCount: components.length,
    appResourceCount: appResources.length,
    namespaceIsolation: true,
    components,
    checks
  });
}

export function isLinkedAppResource(tool: RemoteMcpTool, resource: RemoteMcpResource): boolean {
  return resourceUrisFromMeta(tool.meta ?? null).includes(resource.uri);
}
