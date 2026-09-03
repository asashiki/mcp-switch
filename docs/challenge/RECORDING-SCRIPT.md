# Record the required demo in one take

Target length: **2:30–2:45**. The Devpost limit is strictly under three minutes.

## Before recording

1. Use the latest ChatGPT desktop app and select GPT-5.6 Sol or Terra.
2. Open the public live URL in ChatGPT's built-in browser.
3. In the address bar, open **Site tools → Available site tools** and confirm all five tools appear.
4. Put the page and chat side by side. Use a 16:9 recording area. Turn off notifications.
5. Record microphone audio or read the English narration below with a voice you are allowed to use. Do not add music.

## One-take shot list and narration

### 0:00–0:20 — show the problem

**Screen:** Start on **Overview**. Briefly show the five registered site tools.

**Say:**

> MCP Switch gives an AI client one endpoint for many local and remote MCP servers. But managing that gateway still used to be a normal admin console. The agent could use the tools, but it could not reliably inspect or debug the system it depended on.

### 0:20–0:50 — read structured state

**Ask in chat:**

> Give me a concise overview of this MCP Switch and list only upstreams that need attention.

**Screen:** Let the answer identify Music MCP. Point to **Last shared action** changing on the page.

**Say:**

> WebMCP gives the open page five explicit tools. The agent reads sanitized state instead of scraping cards and guessing. This public challenge build uses safe demo data and has no route to my private gateway.

### 0:50–1:35 — diagnose together

**Ask in chat:**

> Inspect Music MCP's app compatibility and open the relevant diagnostics on the page.

**Screen:** The page changes to **Diagnose** and opens App Lab. Pause on the four checks and the host-bridge warning.

**Say:**

> The tool changes the same page I am looking at. App Lab checks the UI resource link, MCP App MIME type, URI isolation, and host bridge. It does not call the music tool. Here it isolates the reason a player can exist but still fail inside ChatGPT.

### 1:35–2:10 — stage, review, discard

**Ask in chat:**

> Prepare https://example.com/mcp as Example MCP for me to review. Do not save or connect it.

**Screen:** Show the filled draft and the line **Not saved · not connected · not authorized**. Click **Discard** yourself.

**Say:**

> The agent can remove copying and navigation work, but it cannot accept a token, save the server, start OAuth, or delete configuration. It only prepares a visible draft. I keep the final action, and I can discard it here.

### 2:10–2:40 — show the implementation and close

**Screen:** Open **Safety model**, then briefly show `apps/webmcp-challenge-demo/app.js` on GitHub at the `document.modelContext.registerTool` calls.

**Say:**

> The design has three levels: read, visible navigation, and a proposal that stops for human review. The tools are registered imperatively in the top-level page with narrow JSON schemas and explicit side effects. MCP remains the data plane. WebMCP becomes the shared control plane for the person and the agent.

Stop recording. Do not add an outro that pushes the video over three minutes.

## Upload settings

- Title: `MCP Switch — A WebMCP Control Plane for MCP`
- Visibility: **Public**
- Description: `WebMCP Challenge 2026 demo. Live app and source links are in the Devpost submission.`
- Verify the final YouTube duration is **2:59 or shorter** and that audio is audible before pasting the link into Devpost.
