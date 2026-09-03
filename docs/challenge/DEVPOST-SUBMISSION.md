# Devpost submission — ready-to-paste copy

## Project name

**MCP Switch: A WebMCP Control Plane for MCP**

## Tagline

**Let an agent inspect and debug the tool gateway it depends on, while a person keeps the final say.**

## Links

- Live app: `https://mcp-switch-webmcp-review.asashiki-5352.chatgpt.site`
- Public repository: `https://github.com/asashiki/mcp-switch/tree/agent/webmcp-control-plane`
- WebMCP source used by the live app: `https://github.com/asashiki/mcp-switch/tree/agent/webmcp-control-plane/apps/webmcp-challenge-demo`
- Production control-plane source: `https://github.com/asashiki/mcp-switch/tree/agent/webmcp-control-plane/apps/console-web/src/webmcp`
- Video: **paste the public YouTube URL after upload**

## Built with

WebMCP, TypeScript, React, JavaScript, HTML, CSS, Node.js, SQLite, Model Context Protocol, ChatGPT Sites

## Submission description

MCP Switch started as a gateway: it puts local stdio and remote HTTP MCP servers behind one OAuth endpoint. That solves how an AI client calls many tools. It does not solve how a person manages and debugs the gateway itself.

The awkward part became obvious while fixing a Music MCP player that worked in one host and failed inside ChatGPT. The information needed to understand the failure was spread across server status, tool metadata, UI resources, MIME types, bridge conventions, and the page the person was already looking at. A browser agent could click through the console, but every click was another guess.

The WebMCP control plane gives that console five explicit site tools. An agent can read a sanitized gateway overview, list upstream servers, inspect one server, and open the relevant MCP Apps diagnostics in the visible page. It can also prepare a new remote-server draft. That last tool stops before the dangerous part: it cannot accept a token, save configuration, contact the server, start OAuth, or delete anything. The person sees the filled draft and owns the final click.

This is a strong fit for WebMCP because the useful state exists in both places at once. The agent needs structured access to gateway data; the person needs to see which server, warning, or draft the agent is talking about. A background MCP server alone cannot provide that shared visual context, while generic browser actuation cannot describe the permission boundary precisely.

The live challenge app is a public sandbox with realistic demo state and no route to private infrastructure. It registers the same five imperative tools as the authenticated production console. The full console implementation reuses existing API, authorization, diagnostics, routing, and form logic. Tools are registered only in the signed-in top-level page and are removed with an `AbortSignal` when that page unmounts or the user signs out.

The implementation treats upstream names and metadata as untrusted. Read results are sanitized and capped. No WebMCP schema includes credentials, headers, environment variables, or stdio commands. App Lab checks resource links, MCP App MIME, bridge style, URI isolation, CSP, and output schemas without calling the real upstream tool.

The result is intentionally not an autonomous admin bot. It is a small control loop: read, show, propose, review. The agent handles the tedious navigation and cross-checking; the person stays in control of external connections and secrets.

## How it creates a better experience

Before WebMCP, diagnosing the Music MCP component meant manually finding the upstream, opening its tool list, matching a tool to a UI resource, and interpreting several host-specific fields. Preparing a connection also meant copying details from a chat back into the correct form while avoiding secret leakage.

Now the person can ask one question. The agent gets structured, sanitized data and opens the exact diagnostic beside the conversation. A second request can fill a review-only draft. The page visibly changes, so the person can verify the action instead of trusting a hidden background result.

## What was difficult or impossible before

- An MCP client could call gateway tools, but it could not understand the open management page.
- Browser automation could navigate the page, but it had to infer every control from the DOM.
- A background agent could recommend configuration, but it could not place that proposal into the exact visible review state without receiving broader admin access.
- The console could show an MCP Apps failure, but the agent could not reliably connect the diagnostic data to the person's current view.

## How WebMCP was implemented

The signed-in console registers five tools with `document.modelContext.registerTool()` in the top-level document. Three tools are read-only. One changes only the visible route and App Lab panel. One fills a non-sensitive draft and always returns `persisted: false` and `connected: false`.

The public judging surface is plain HTML, CSS, and JavaScript so it loads without an account or backend. Its complete source is included in the repository. The production React implementation uses the same tool contract against the authenticated gateway API. Contract and safety tests cover registration cleanup, redaction, server resolution, visible diagnostics navigation, draft-only behavior, and unsafe URL rejection.

## Testing instructions for judges

1. Open the live app directly in ChatGPT's built-in browser. Use GPT-5.6 Sol or Terra. Alternatively, use Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.
2. Confirm that the address-bar Site tools menu lists five tools.
3. Ask: `Give me a concise overview of this MCP Switch and list only upstreams that need attention.`
4. Ask: `Inspect Music MCP's app compatibility and open the relevant diagnostics on the page.` The page should switch to **Diagnose** and expand Music MCP App Lab.
5. Ask: `Prepare https://example.com/mcp as Example MCP for me to review. Do not save or connect it.` A highlighted draft should appear with **Not saved · not connected · not authorized**.
6. Discard the draft. No account, password, or credential is required.

## Existing project versus challenge work

MCP Switch existed before the challenge. The WebMCP control plane was added during the submission period. The timestamped range from the last non-WebMCP base through the submission branch is visible here:

`https://github.com/asashiki/mcp-switch/compare/a462c3262ad442d244aa1b836c2caef5397a29ad...agent/webmcp-control-plane`

The first WebMCP-specific commit is `8c787b7` on September 3, 2026. Later commits add safety tests, documentation, the public judging surface, and submission material. Pre-existing gateway functionality is context; the submission asks to evaluate the new WebMCP control plane.

## Open-source license

MIT. The repository includes [`LICENSE`](../../LICENSE).

## Final checklist

- [x] Working WebMCP app
- [x] Public live URL prepared
- [x] Public source repository
- [x] Complete live-demo source in the repository
- [x] Open-source license
- [x] English description and testing instructions
- [x] New-versus-existing work documented with commit history
- [ ] Record a demo shorter than three minutes with audio
- [ ] Upload it publicly to YouTube and paste the URL above
- [ ] Join the hackathon and submit the Devpost form before September 3, 2026 at 1:00 PM PDT
