

<div align="center">

# MCP Switch

**One self-hosted endpoint for local and remote MCP servers.**

![license](https://img.shields.io/badge/license-MIT-e96ba8)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![status](https://img.shields.io/badge/status-beta-8b8bef)

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

🔗 **[Original console demo](https://show.asashiki.com/console/)** · 📖 **[User manual](docs/manual.md)**

</div>

---

## Why

Web/app AIs can only connect to **remote** MCP servers, and most of them give you
just **one** custom connector slot. Meanwhile half the useful MCP servers are
**local** (`npx`/`uvx` stdio processes) that only Claude Desktop / a CLI can reach.

MCP Switch sits in the middle:

```
   local stdio MCP  ─┐
                     ┼──►  MCP Switch  ──►  one OAuth URL  ──►  claude.ai / ChatGPT / …
   yet another MCP  ─┘     (your VPS)
```

- **Aggregate** any number of MCP servers — remote (URL) or local (stdio, hosted on
  your box) — into one endpoint.
- **Connect once.** Your AI sees a single connector; behind it are all your tools.
- **Manage from a console** — add servers, group tools, scope which agent sees what,
  watch an audit log.
- **Work with the console through WebMCP** — supported browser agents can inspect
  the gateway, open App Lab diagnostics, and prepare review-only connection drafts
  in the same signed-in page.
- **Pure relay.** MCP Switch ships no tools of its own; it forwards tools, schemas,
  results and even MCP-Apps UI widgets transparently.

## Architecture

A **single service** (`:4577`) + a console SPA it serves:

| Part | Role |
|---|---|
| MCP gateway | Public MCP endpoint (`/mcp`), OAuth 2.1, management console (`/console`) |
| Registry | Connects to upstream MCP servers in-process — remote (HTTP) and local (stdio) |
| Store | One SQLite file: agents, OAuth, audit, the skill registry, and the server registry |

No separate backend, no inter-service HTTP — the gateway talks to upstream
servers directly and aggregates them.

## Quick start (Docker)

```bash
git clone https://github.com/asashiki/mcp-switch.git
cd mcp-switch
cp .env.example .env
# edit .env → set MCP_PUBLIC_URL to enable OAuth + the console (leave empty for local)

docker compose -f infra/docker/compose.yaml --env-file .env up -d --build
```

Then:

- Health: `curl http://127.0.0.1:4577/health`
- Console: open `http://127.0.0.1:4577/console` (set a password first — see below)

> Behind a reverse proxy on the same VPS? Set `MCP_PUBLIC_URL`; keep the host-side port bound to `127.0.0.1`.

### Set the console password

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin "your-password"
```

## Quick start (local dev)

```bash
pnpm install
cp .env.example .env          # leave MCP_PUBLIC_URL empty for an anonymous local /mcp
pnpm dev                      # gateway :4577 + console :5173
```

Without `MCP_PUBLIC_URL`, the gateway serves an anonymous `/mcp` — handy for trying
it out locally before wiring up OAuth.

## Connect an AI

In claude.ai → Settings → Connectors → **Add custom connector**, point it at:

```
https://<your MCP_PUBLIC_URL>/mcp
```

Complete the OAuth login (pick an agent identity in the consent screen). Your
aggregated tools now show up in the client.

## Add upstream MCP servers

Open the console → **Connect**. Two ways:

**Remote (HTTP).** Paste the server URL; add headers (e.g. an API key) or OAuth if it
needs auth. Example — Context7:

```json
{ "mcpServers": { "context7": {
  "serverUrl": "https://mcp.context7.com/mcp",
  "headers": { "CONTEXT7_API_KEY": "..." }
}}}
```

**Local (stdio).** MCP Switch spawns the process on your server and exposes it
remotely. Example — a Steam MCP via `npx`:

```json
{ "mcpServers": { "steam": {
  "command": "npx",
  "args": ["-y", "steam-mcp-server"],
  "env": { "STEAM_API_KEY": "..." }
}}}
```

Paste either JSON straight into the console's import box — it auto-detects the
transport and fills the form. The container ships Node/`npx`; for `uvx`/Python
servers, add those runtimes to the image.

## Configuration

All via `.env` (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `MCP_PUBLIC_URL` | Public origin; **set it to enable OAuth + console**, unset = anonymous local `/mcp` |
| `MCP_AUTH_DB_PATH` | Local-development SQLite path; Docker always uses its `/data` volume |
| `MCP_OAUTH_SCOPE` | OAuth scopes advertised to clients |
| `MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION` | Upgrade bridge for old clients that omit RFC 8707 `resource`; turn off after re-authorization |
| `MCP_CONSOLE_CORS_ORIGINS` | Comma-separated list of allowed console SPA origins (default: `http://localhost:5173,http://localhost:3000`) |
| `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` | Optional MCP transport allowlists; safe values are derived from the public URL when empty |
| `REMOTE_MCP_SERVERS_JSON` | Optional: pre-seed upstream servers instead of using the console |
| `MCP_GATEWAY_HOST` | Local-development listen address; Docker overrides it safely inside the container |
| `MCP_GATEWAY_BIND_HOST` | Host-side published address; defaults to `127.0.0.1` for a same-VPS reverse proxy |

## Docs

- [VPS deployment handoff](docs/VPS-DEPLOY.zh-CN.md) — short instructions that can be handed directly to an AI on the server.
- [使用手册](docs/manual.md) — step-by-step walkthrough of the console.
- [安全升级与回滚](docs/deployment-and-upgrade.zh-CN.md) — run a parallel instance before switching traffic.
- [2026 部署与远程测试选择](docs/deployment-options-2026.zh-CN.md) — current platform trade-offs.
- [MCP Apps App Lab](docs/mcp-apps-app-lab.zh-CN.md) — diagnose component metadata, MIME, CSP and bridge behavior.
- [WebMCP Control Plane](docs/webmcp-control-plane.zh-CN.md) — safe inspection, App Lab navigation and review-only connection drafts.
- [文章资料包](docs/blog/MCP-SWITCH-ARTICLE-KIT.zh-CN.md) and [first-person draft](docs/blog/MCP-SWITCH-ARTICLE-DRAFT.zh-CN.md).

## Development

```bash
pnpm typecheck      # all packages
pnpm test           # WebMCP contracts + gateway tests (incl. upstream→gateway e2e)
pnpm build          # build everything
```

Monorepo: `apps/{mcp-gateway,console-web}`, `packages/{schemas,config}`.

## License

[MIT](LICENSE)
