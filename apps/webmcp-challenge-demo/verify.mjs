import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const [html, script, css] = await Promise.all([
  readFile(join(directory, "index.html"), "utf8"),
  readFile(join(directory, "app.js"), "utf8"),
  readFile(join(directory, "app.css"), "utf8"),
]);

new Function(script);

const expectedTools = [
  "mcp_switch_overview",
  "list_upstream_mcp_servers",
  "inspect_upstream_mcp_server",
  "open_mcp_app_lab",
  "prepare_remote_mcp_server",
];

const failures = [];
for (const asset of ["./app.css", "./app.js"]) {
  if (!html.includes(asset)) failures.push(`index.html does not load ${asset}`);
}
for (const tool of expectedTools) {
  if (!script.includes(`name: "${tool}"`)) failures.push(`missing WebMCP tool ${tool}`);
}
if (!script.includes("document.modelContext.registerTool")) {
  failures.push("the imperative document.modelContext.registerTool call is not visible in demo source");
}
if (!script.includes("new AbortController()")) failures.push("tool registration has no lifecycle cleanup");
if (!script.includes("persisted: false") || !script.includes("connected: false")) {
  failures.push("the connection tool does not make draft-only behavior explicit");
}
if (html.includes("PR #6 REVIEW") || html.includes("私有评审环境")) {
  failures.push("private review copy leaked into the public challenge build");
}
if (!css.trim()) failures.push("app.css is empty");

if (failures.length) {
  throw new Error(`Challenge demo verification failed:\n- ${failures.join("\n- ")}`);
}

console.log(`Challenge demo verified: ${expectedTools.length} WebMCP tools, linked assets, safe draft contract.`);
