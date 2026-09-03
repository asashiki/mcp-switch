# MCP Switch × WebMCP — demo and submission brief

## One-line pitch

MCP Switch turns a browser-only MCP gateway console into a shared control plane where a person and an agent can inspect upstream servers, diagnose broken MCP Apps, and prepare connection drafts without giving the agent silent administrative power.

## What is new WebMCP work

The existing project already aggregated local stdio and remote HTTP MCP servers behind one OAuth endpoint. The WebMCP addition is a new browser control layer:

- five top-level imperative Site tools registered after console authentication;
- shared page navigation that focuses an upstream and opens App Lab diagnostics;
- a review-only remote-server draft workflow;
- explicit read-only and untrusted-content annotations;
- secret-minimizing schemas and sanitized results;
- abort-driven registration cleanup and request cancellation;
- automated WebMCP contract and safety tests.

## Suggested public demo flow (under three minutes)

### 0:00–0:25 — the problem

Show several local and remote MCP servers behind one MCP Switch endpoint. Explain that MCP connects an AI client to the gateway, but managing and debugging the gateway still requires a person to click through a conventional admin console.

### 0:25–1:05 — understand the live system

Open the signed-in console in the ChatGPT built-in browser. Ask:

> Give me a concise overview of this MCP Switch and list only upstreams that need attention.

Show the Site tools activity and the sanitized answer. Point out that no endpoints or secrets are returned.

### 1:05–1:55 — diagnose a broken chat component together

Ask:

> Inspect Music MCP's app compatibility and open the relevant diagnostics on the page.

The agent navigates the same visible console, focuses Music MCP, and expands App Lab. Show checks for MCP Apps resource linking, bridge style, MIME, CSP, URI namespacing, and output schema. Emphasize that the diagnostic does not invoke the music tool.

### 1:55–2:35 — stage, review, commit

Ask:

> Prepare https://example.com/mcp as Example MCP for me to review.

Show the highlighted draft. The agent has not contacted or saved the server and cannot provide a token. Add any credential manually (or leave it blank in the demo), explain the final human click, then discard the sample draft.

### 2:35–2:55 — close

Summarize the split:

- MCP is the always-on data plane;
- WebMCP is the shared browser control plane;
- MCP Apps App Lab is the compatibility/debugging plane.

## Screenshots worth capturing

1. The compact “WebMCP site tools” status strip after login.
2. ChatGPT's Available site tools list showing all five tools.
3. The agent response beside the console overview.
4. Music MCP focused with App Lab open and one actionable warning visible.
5. The highlighted review draft and its “not saved / not connected” notice.

## Verification claims allowed in a submission

- The implementation uses the imperative top-level `document.modelContext.registerTool()` API.
- Site tools are registered only for an authenticated console view.
- Read tools expose sanitized management data and mark upstream-derived output as untrusted.
- The only configuration-oriented tool creates a local review draft; it never writes backend state.
- Automated tests cover registration cleanup, result redaction, diagnostics navigation, draft-only behavior, and unsafe URL rejection.

Do not claim a public deployment, live browser compatibility run, or challenge submission until each one has actually been completed and recorded.

