import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteMcpServer } from "@mcp-switch/schemas";
import { MCP_APP_MIME_TYPE } from "./proxy-metadata.js";
import { appHtmlFromContents, diagnoseMcpApps } from "./app-diagnostics.js";
import { inspectAppHtml } from "./app-html-diagnostics.js";

function server(overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
  return {
    id: "music",
    name: "Music",
    url: "https://music.example/mcp",
    description: "music test",
    authMode: "none",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
    toolCount: 1,
    readOnlyToolCount: 1,
    writeToolCount: 0,
    tools: [{
      serverId: "music",
      name: "play_song",
      title: "Play song",
      description: "player",
      readOnlyHint: true,
      requiredArguments: [],
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: {
          mode: { enum: ["song", "playlist"] },
          queue: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, audioUrl: { type: "string", format: "uri" } }
            }
          }
        }
      },
      meta: {
        ui: { resourceUri: "ui://music/player.html" },
        "openai/outputTemplate": "ui://music/player.html"
      }
    }],
    resources: [{
      uri: "ui://music/player.html",
      name: "player",
      title: "Player",
      description: null,
      mimeType: MCP_APP_MIME_TYPE,
      meta: {
        ui: {
          csp: {
            connectDomains: ["https://music.example"],
            resourceDomains: ["https://music.example"]
          }
        }
      }
    }],
    ...overrides
  };
}

test("diagnostics recognize a portable MCP App and generate safe sample data", async () => {
  const result = await diagnoseMcpApps(server(), async (uri) => ({
    contents: [{
      uri,
      mimeType: MCP_APP_MIME_TYPE,
      text: `<script>parent.postMessage({jsonrpc:"2.0",method:"ui/initialize"}, "*")</script>`
    }]
  }));
  assert.equal(result.status, "pass");
  assert.equal(result.validationScope, "static");
  assert.equal(result.runtimeVerified, false);
  assert.ok(result.checks.some(check => check.code === "runtime-not-verified"));
  assert.equal(result.uiToolCount, 1);
  assert.equal(result.components[0]?.bridge, "mcp-apps");
  assert.match(result.components[0]?.proxyUri ?? "", /^ui:\/\/mcp-switch\/music\//);
  assert.deepEqual(result.components[0]?.sampleStructuredContent, {
    mode: "song",
    queue: [{ title: "Example title", audioUrl: "https://example.com/resource" }]
  });
});

test("diagnostics flag OpenAI-only legacy metadata without breaking compatibility", async () => {
  const legacy = server({
    tools: [{
      ...server().tools[0]!,
      outputSchema: null,
      meta: { "openai/outputTemplate": "ui://music/player.html" }
    }],
    resources: [{
      ...server().resources![0]!,
      mimeType: "text/html+skybridge",
      meta: {
        "openai/widgetDomain": "https://music.example",
        "openai/widgetCSP": { connect_domains: ["https://music.example"] }
      }
    }]
  });
  const result = await diagnoseMcpApps(legacy, async (uri) => ({
    contents: [{ uri, mimeType: "text/html+skybridge", text: `<script>window.openai?.toolOutput</script>` }]
  }));
  assert.equal(result.status, "warning");
  assert.equal(result.components[0]?.normalizedMimeType, MCP_APP_MIME_TYPE);
  assert.equal(result.components[0]?.bridge, "openai-only");
  const codes = new Set(result.checks.map((check) => check.code));
  assert.ok(codes.has("tool-openai-only"));
  assert.ok(codes.has("mime-legacy"));
  assert.ok(codes.has("resource-openai-only"));
  assert.ok(codes.has("output-schema-missing"));
});

test("diagnostics fail closed for mismatched links and missing resources", async () => {
  const broken = server({
    tools: [{
      ...server().tools[0]!,
      meta: {
        ui: { resourceUri: "ui://missing/standard.html" },
        "openai/outputTemplate": "ui://missing/openai.html"
      }
    }],
    resources: []
  });
  const result = await diagnoseMcpApps(broken, async () => {
    throw new Error("should not read an undiscovered resource");
  });
  assert.equal(result.status, "error");
  const codes = new Set(result.checks.map((check) => check.code));
  assert.ok(codes.has("tool-uri-mismatch"));
  assert.ok(codes.has("resource-missing"));
});

test("preview extraction accepts text/blob and enforces the size ceiling", () => {
  assert.equal(appHtmlFromContents({ contents: [{ uri: "ui://x", text: "<main>x</main>" }] }, "ui://x").html, "<main>x</main>");
  assert.equal(
    appHtmlFromContents({ contents: [{ uri: "ui://x", blob: Buffer.from("<main>b</main>").toString("base64") }] }, "ui://x").html,
    "<main>b</main>"
  );
  assert.throws(
    () => appHtmlFromContents({ contents: [{ uri: "ui://x", text: "x".repeat(20) }] }, "ui://x", 10),
    /exceeds 10 bytes/
  );
});

test("HTML inspection distinguishes media resources from network connection CSP", async () => {
  const result = await diagnoseMcpApps(server(), async (uri) => ({ contents: [{
    uri, mimeType: MCP_APP_MIME_TYPE,
    text: '<audio autoplay src="https://cdn.example/song.mp3?token=secret"></audio><meta name="viewport" content="width=1024">'
  }] }));
  const codes = new Set(result.checks.map((c) => c.code));
  assert.ok(codes.has("media-autoplay"));
  assert.ok(codes.has("asset-csp-origin-missing"));
  assert.ok(codes.has("viewport-fixed-width"));
  assert.ok(codes.has("media-runtime-check"));
  assert.equal(result.runtimeVerified, false);
  assert.equal(JSON.stringify(result.checks).includes("token=secret"), false);
  const checks = inspectAppHtml('<audio src="https://music.example/a.mp3">', {
    connectDomains: ["https://music.example"], resourceDomains: [], frameDomains: []
  });
  assert.ok(checks.some((c) => c.code === "asset-csp-origin-missing" && c.message.includes("resourceDomains")));
});

test("literal asset hints respect resource and frame origins without claiming runtime success", () => {
  const checks = inspectAppHtml('<audio controls src="https://music.example/a.mp3"><iframe src="https://frame.example/x"></iframe><meta name="viewport" content="width=device-width"><style>body{color:var(--color-text-primary)}</style>', {
    resourceDomains: ["https://music.example/"], frameDomains: ["https://frame.example"], connectDomains: []
  });
  assert.equal(checks.some((c) => c.severity === "warning" || c.severity === "error" || c.severity === "pass"), false);
  assert.ok(checks.some((c) => c.code === "media-runtime-check"));
});

test("HTML hints ignore comments/raw script text and cap large resource lists", () => {
  const csp = { connectDomains: [], resourceDomains: [], frameDomains: [] };
  const ignored = inspectAppHtml('<!-- <audio autoplay src="https://bad.example"> --><script>const example = `<audio autoplay>`;</script>', csp);
  assert.equal(ignored.some((c) => c.code === "media-autoplay"), false);
  const many = inspectAppHtml(Array.from({ length: 100 }, (_, i) => `<img src="https://asset${i}.example/x">`).join(""), csp);
  assert.equal(many.length, 17);
  assert.equal(many.at(-1)?.code, "html-findings-truncated");
  const wildcard = inspectAppHtml('<img src="https://a.example/x">', { ...csp, resourceDomains: ["https://*.example"] });
  assert.ok(wildcard.some((c) => c.code === "asset-csp-wildcard-unverified" && c.severity === "info"));
});

test("large catalogs truncate findings without losing late errors or failing report validation", async () => {
  const base = server();
  const tools = Array.from({ length: 100 }, (_, i) => ({ ...base.tools[0]!, name: `tool_${i}` }));
  tools.push({ ...base.tools[0]!, name: "last_broken", meta: { ui: { resourceUri: "ui://missing" }, "openai/outputTemplate": "ui://missing" } });
  let reads = 0;
  const result = await diagnoseMcpApps(server({ tools }), async (uri) => {
    reads++;
    return { contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: "<main>Static</main>" }] };
  });
  assert.equal(reads, 1);
  assert.equal(result.checks.length, 512);
  assert.equal(result.checks.at(-1)?.code, "diagnostics-truncated");
  assert.equal(result.status, "error");
  assert.equal(result.components.length, 101);
});
