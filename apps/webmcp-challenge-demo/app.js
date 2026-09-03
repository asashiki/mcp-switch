const servers = [
  { id: "music-mcp", name: "Music MCP", status: "attention", transport: "http", toolCount: 12, uiToolCount: 1, authMode: "oauth", oauthAuthorized: true },
  { id: "sticker-mcp", name: "Sticker MCP", status: "online", transport: "http", toolCount: 18, uiToolCount: 3, authMode: "oauth", oauthAuthorized: true },
  { id: "timeline-mcp", name: "Timeline MCP", status: "online", transport: "http", toolCount: 7, uiToolCount: 0, authMode: "gateway", oauthAuthorized: true },
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let toastTimer;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function recordAction(message) {
  const element = $("#last-action");
  if (element) element.textContent = message;
}

function showView(view) {
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-link").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openAppLab(source = "person") {
  showView("remote");
  const lab = $("#app-lab");
  lab.hidden = false;
  $("#open-app-lab").textContent = "Close App Lab";
  recordAction(source === "agent" ? "Agent opened Music MCP diagnostics" : "You opened Music MCP diagnostics");
  setTimeout(() => $("#music-card").scrollIntoView({ behavior: "smooth", block: "center" }), 80);
}

function stageDraft({ name = "Example MCP", url = "https://example.com/mcp", description = "Prepared by WebMCP for human review." } = {}, source = "person") {
  showView("remote");
  $("#draft-empty").hidden = true;
  $("#draft-form").hidden = false;
  $("#draft-name").value = name;
  $("#draft-url").value = url;
  $("#draft-description").value = description;
  recordAction(source === "agent" ? "Agent prepared a review-only connection draft" : "You created a sample review draft");
  setTimeout(() => $("#draft-card").scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  toast("Draft prepared. Nothing was saved, connected, or authorized.");
}

function resolveServer(value) {
  const needle = String(value || "").trim().toLowerCase();
  const match = servers.find((server) => server.id === needle || server.name.toLowerCase() === needle);
  if (!match) throw new Error(`Unknown upstream server: ${value}`);
  return match;
}

function webMcpTools() {
  return [
    {
      name: "mcp_switch_overview",
      title: "MCP Switch overview",
      description: "Read a concise, sanitized overview of this MCP Switch challenge sandbox and its current page. Does not expose secrets or change configuration.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        recordAction("Agent read the sanitized gateway overview");
        return {
          demoData: true,
          gateway: { name: "MCP Switch", mode: "public WebMCP challenge sandbox" },
          upstreams: { total: 3, online: 2, attention: 1, awaitingAuthorization: 0 },
          tools: { discovered: 37, enabledReadOnly: 29, enabledWrite: 8 },
          protocol: { downstream: ["2026-07-28", "2025-11-25"], upstreamNegotiation: "auto" },
          console: { view: location.hash.slice(1) || "overview", appLabOpen: !$("#app-lab").hidden, draftPending: !$("#draft-form").hidden },
          safety: "No endpoint, credential, header, environment value, or private infrastructure is exposed.",
        };
      },
    },
    {
      name: "list_upstream_mcp_servers",
      title: "List upstream MCP servers",
      description: "List sanitized upstream MCP status in this sandbox, filtered to all, online, or attention. Does not return endpoints, credentials, headers, environment values, or tool descriptions.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: ["all", "online", "attention"], default: "all", description: "Status group to return." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async ({ status = "all" } = {}) => {
        if (!["all", "online", "attention"].includes(status)) throw new Error("status must be all, online, or attention");
        const filtered = servers.filter((server) => status === "all" || server.status === status);
        recordAction(`Agent listed ${status === "all" ? "all" : status} upstreams`);
        return { demoData: true, filter: status, total: filtered.length, servers: filtered };
      },
    },
    {
      name: "inspect_upstream_mcp_server",
      title: "Inspect an upstream MCP server",
      description: "Inspect one upstream by exact ID or display name. Returns sanitized state and capabilities only.",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string", minLength: 1, maxLength: 128, description: "Exact upstream server ID or display name." } },
        required: ["server"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async ({ server } = {}) => {
        const selected = resolveServer(server);
        recordAction(`Agent inspected ${selected.name}`);
        return { demoData: true, ...selected, credentialsExposed: false };
      },
    },
    {
      name: "open_mcp_app_lab",
      title: "Open MCP Apps compatibility lab",
      description: "Open the selected upstream in the visible page and run safe MCP Apps compatibility diagnostics. Changes only the current page; invokes no upstream tool and saves nothing.",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string", minLength: 1, maxLength: 128, description: "Exact upstream server ID or display name." } },
        required: ["server"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async ({ server } = {}) => {
        const selected = resolveServer(server);
        if (selected.id === "music-mcp") openAppLab("agent");
        else {
          showView("remote");
          recordAction(`Agent focused ${selected.name}`);
        }
        return {
          pageUpdated: true,
          upstream: selected,
          diagnostics: {
            resourceLink: "pass",
            mimeType: "pass",
            namespaceIsolation: "pass",
            hostBridge: selected.id === "music-mcp" ? "warning" : "pass",
          },
          safety: "No upstream tool was invoked and no configuration was changed.",
        };
      },
    },
    {
      name: "prepare_remote_mcp_server",
      title: "Prepare a remote MCP server draft",
      description: "Fill the visible form with a review-only HTTP(S) connection draft. Never saves, connects, authorizes, or discovers the server; a person must review the page and take the final action.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "Human-readable upstream name." },
          url: { type: "string", minLength: 1, maxLength: 2048, description: "Absolute HTTP(S) Streamable MCP endpoint without credentials." },
          description: { type: "string", maxLength: 500, description: "Optional non-sensitive note for the human reviewer." },
        },
        required: ["name", "url"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async ({ name, url, description = "" } = {}) => {
        if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("name must contain 1–80 characters");
        if (typeof url !== "string" || url.length > 2048) throw new Error("url must be an absolute HTTP(S) URL");
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("url must use HTTP or HTTPS");
        if (parsed.username || parsed.password) throw new Error("Do not put credentials in the server URL");
        if (typeof description !== "string" || description.length > 500) throw new Error("description must be at most 500 characters");
        stageDraft({ name: name.trim(), url: parsed.toString(), description: description.trim() }, "agent");
        return {
          status: "drafted",
          persisted: false,
          connected: false,
          authorized: false,
          nextStep: "Review the highlighted draft in the visible page. Add any credential yourself, then save manually.",
        };
      },
    },
  ];
}

async function registerWebMcp() {
  const state = $("#webmcp-state");
  const modelContext = document.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    state.textContent = "Not available in this browser · the manual demo still works";
    return;
  }

  const controller = new AbortController();
  window.addEventListener("pagehide", () => controller.abort(), { once: true });
  let registered = 0;
  for (const tool of webMcpTools()) {
    try {
      await document.modelContext.registerTool(tool, { signal: controller.signal });
      registered += 1;
    } catch (error) {
      console.warn(`WebMCP registration failed: ${tool.name}`, error);
    }
  }
  state.textContent = registered === 5 ? "5 tools registered · ask the agent to use this page" : `${registered} / 5 tools registered`;
}

async function copyPrompt(prompt) {
  try {
    await navigator.clipboard.writeText(prompt);
    toast("Prompt copied. Paste it into the chat beside this page.");
  } catch {
    toast(prompt);
  }
}

$$('[data-view]').forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$('[data-open-server]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.openServer === "music-mcp") openAppLab();
  else {
    showView("remote");
    recordAction(`You focused ${resolveServer(button.dataset.openServer).name}`);
  }
}));
$$('[data-toast]').forEach((button) => button.addEventListener("click", () => toast(button.dataset.toast)));
$$('[data-prompt]').forEach((button) => button.addEventListener("click", () => copyPrompt(button.dataset.prompt)));

$("#open-app-lab").addEventListener("click", () => {
  const lab = $("#app-lab");
  if (lab.hidden) openAppLab();
  else {
    lab.hidden = true;
    $("#open-app-lab").textContent = "Open App Lab";
    recordAction("You closed Music MCP diagnostics");
  }
});
$("#fill-demo").addEventListener("click", () => stageDraft());
$("#discard-draft").addEventListener("click", () => {
  $("#draft-form").hidden = true;
  $("#draft-empty").hidden = false;
  recordAction("You discarded the unsaved draft");
  toast("Draft discarded. No configuration was changed.");
});

const dialog = $("#tool-dialog");
$("#tool-list-button").addEventListener("click", () => dialog.showModal());
$(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
});

const initial = location.hash.slice(1);
if (["overview", "remote", "design"].includes(initial)) showView(initial);
window.__MCP_SWITCH_WEBMCP_TOOLS__ = webMcpTools;
registerWebMcp();
