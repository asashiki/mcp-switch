import type { McpAppDiagnostics } from "@mcp-switch/schemas";

type Check = Pick<McpAppDiagnostics["checks"][number], "severity" | "code" | "message">;
type Csp = McpAppDiagnostics["components"][number]["csp"];

/** Literal-source hints only: no HTML execution, network requests, or host verdicts. */
export function inspectAppHtml(html: string, csp: Csp): Check[] {
  const checks: Check[] = [];
  const seen = new Set<string>();
  const add = (severity: Check["severity"], code: string, message: string) => {
    const key = `${code}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (checks.length < 16) checks.push({ severity, code, message });
  };
  // Ignore comments and raw-text bodies so string literals are not mistaken for
  // real media tags. This deliberately is not a browser HTML parser.
  const markup = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, "$1");
  let mediaFound = false;
  let viewportFound = false;
  const tags = /<(audio|video|source|img|script|link|iframe|meta)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const match of markup.matchAll(tags)) {
    const tag = match[1]!.toLowerCase();
    const attrs = new Map<string, string>();
    for (const attr of match[2]!.matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attr[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    if (tag === "meta" && attrs.get("name")?.toLowerCase() === "viewport") {
      viewportFound = true;
      const width = /(?:^|[,;\s])width\s*=\s*(\d+)/i.exec(attrs.get("content") ?? "");
      if (width && Number(width[1]) > 480) add("warning", "viewport-fixed-width", "Viewport declares a fixed width above 480px. Check clipping in narrow chat and mobile containers; prefer width=device-width.");
    }
    if (tag === "audio" || tag === "video") {
      mediaFound = true;
      if (attrs.has("autoplay")) add("warning", "media-autoplay", "A media element requests autoplay. Host policy may reject it even with valid CSP; provide a user-initiated play action and handle play() rejection.");
    }
    // These attributes load resources, not fetch/XHR connections. Media origins
    // belong in resourceDomains; adding only connectDomains does not cover them.
    const value = attrs.get(tag === "link" ? "href" : "src");
    if (!value || tag === "meta") continue;
    if (tag === "link" && !/(?:^|\s)(stylesheet|preload|modulepreload|icon)(?:\s|$)/i.test(attrs.get("rel") ?? "")) continue;
    if (!/^https?:\/\//i.test(value)) {
      if (!/^(data:|blob:)/i.test(value)) add("info", "asset-url-unresolved", "Relative or protocol-relative asset URLs were found. Resolve them against the actual host resource base during runtime verification.");
      continue;
    }
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (url.protocol === "http:") add("warning", "asset-insecure-http", `A literal asset uses HTTP at ${url.origin}. HTTPS hosts may block mixed content; serve it over HTTPS.`);
    const field = tag === "iframe" ? "frameDomains" : "resourceDomains";
    const declared = csp[field];
    const exactMatch = declared.some((entry) => {
      try { const domain = new URL(entry); return domain.origin === url.origin && domain.pathname === "/" && !domain.search && !domain.hash && !domain.username && !domain.password; }
      catch { return false; }
    });
    if (!exactMatch) {
      const wildcard = declared.some((entry) => entry.includes("*"));
      add(wildcard ? "info" : "warning", wildcard ? "asset-csp-wildcard-unverified" : "asset-csp-origin-missing",
        `Literal <${tag}> asset origin ${url.origin} has no exact entry in ${field}. ${wildcard ? "Wildcard policy requires host verification." : `Check host defaults and add this origin to ${field} if required.`}`);
    }
  }
  if (mediaFound) add("info", "media-runtime-check", "Media playback is unverified. In each target host, test user click, play() rejection, HTTP status, media MIME type, range requests, URL expiry, and repeated tool-result notifications.");
  if (!viewportFound) add("info", "viewport-not-detected", "No literal viewport declaration found. Check the actual iframe width and mobile layout; this alone does not prove a layout failure.");
  if (!/--color-background|--color-text|prefers-color-scheme|host-context-changed|onhostcontextchanged|applyDocumentTheme/i.test(html)) {
    add("info", "theme-hooks-not-detected", "No recognized host-theme or color-scheme markers found. Verify light/dark contrast and background blending; external scripts or styles may provide them.");
  }
  if (seen.size > 16) checks.push({ severity: "info", code: "html-findings-truncated", message: "More than 16 distinct HTML hints found; only the first 16 are shown." });
  return checks;
}
