# MCP Switch WebMCP challenge sandbox

This directory is the complete source of the public judging surface:

- [`index.html`](index.html) is the human-visible MCP Switch console.
- [`app.js`](app.js) registers five imperative WebMCP tools from the top-level page.
- [`app.css`](app.css) contains the responsive light/dark interface.

It deliberately uses safe demo data. It has no credential, network route, or write path to the author's private MCP gateway. The production console implementation lives in [`../console-web/src/webmcp`](../console-web/src/webmcp) and calls the authenticated MCP Switch API with the same read → navigate → draft permission model.

## Run locally

Serve this directory from any static HTTP server. For example:

```bash
python -m http.server 4173 --directory apps/webmcp-challenge-demo
```

Open `http://localhost:4173`. The normal interface works in every modern browser. To discover and call the five site tools, use ChatGPT's built-in browser or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.

## Three-step test

1. Ask: `Give me a concise overview of this MCP Switch and list only upstreams that need attention.`
2. Ask: `Inspect Music MCP's app compatibility and open the relevant diagnostics on the page.`
3. Ask: `Prepare https://example.com/mcp as Example MCP for me to review. Do not save or connect it.`

The second call visibly opens App Lab. The third visibly fills a connection draft but cannot persist it. Each result states whether the page or configuration changed.

## Site tools

| Tool | Effect |
|---|---|
| `mcp_switch_overview` | Returns sanitized gateway and page state |
| `list_upstream_mcp_servers` | Lists all, online, or attention-needed upstreams |
| `inspect_upstream_mcp_server` | Inspects one sanitized upstream |
| `open_mcp_app_lab` | Opens visible, read-only MCP Apps diagnostics |
| `prepare_remote_mcp_server` | Fills a non-sensitive draft for human review |

Tokens, secrets, headers, environment variables, stdio commands, saving, authorization, discovery, and deletion are outside every WebMCP tool schema.
