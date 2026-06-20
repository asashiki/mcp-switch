<div align="center">

# MCP Switch

**One MCP endpoint to rule them all.**

A self-hosted gateway that aggregates your local **and** remote MCP servers behind a
single, OAuth-secured endpoint — then exposes them to any AI that speaks MCP
(claude.ai, ChatGPT, etc.).

![license](https://img.shields.io/badge/license-MIT-e96ba8)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![status](https://img.shields.io/badge/status-beta-8b8bef)

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

🔗 **[Live console demo](https://show.asashiki.com/console/)** · 📖 **[User manual](docs/manual.md)**

</div>

---

## Why

Web/app AIs can only connect to **remote** MCP servers, and most of them give you
just **one** custom connector slot. Meanwhile half the useful MCP servers are
**local** (`npx`/`uvx` stdio processes) that only Claude Desktop / a CLI can reach.

MCP Switch sits in the middle:

```
   local stdio MCP  ─┐
   another stdio MCP ─┤
   remote HTTP MCP   ─┼──►  MCP Switch  ──►  one OAuth URL  ──►  claude.ai / ChatGPT / …
   yet another MCP   ─┘     (your VPS)
```

- **Aggregate** any number of MCP servers — remote (URL) or local (stdio, hosted on
  your box) — into one endpoint.
- **Connect once.** Your AI sees a single connector; behind it are all your tools.
- **Manage from a console** — add servers, group tools, scope which agent sees what,
  watch an audit log.
- **Pure relay.** MCP Switch ships no tools of its own; it forwards tools, schemas,
  results and even MCP-Apps UI widgets transparently.

## Architecture

A **single service** (`:4200`) + a console SPA it serves:

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

- Health: `curl http://127.0.0.1:4200/health`
- Console: open `http://127.0.0.1:4200/console` (set a password first — see below)

> Behind a reverse proxy? Set `MCP_PUBLIC_URL` and `MCP_GATEWAY_BIND_HOST=0.0.0.0` in `.env`.

### Set the console password

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin "your-password"
```

## Quick start (local dev)

```bash
pnpm install
cp .env.example .env          # leave MCP_PUBLIC_URL empty for an anonymous local /mcp
pnpm dev                      # gateway :4200 + console :5173
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
| `MCP_AUTH_DB_PATH` | SQLite file (agents, OAuth, audit, skills, server registry) |
| `MCP_OAUTH_SCOPE` | OAuth scopes advertised to clients |
| `REMOTE_MCP_SERVERS_JSON` | Optional: pre-seed upstream servers instead of using the console |
| `MCP_GATEWAY_BIND_HOST` | Bind `0.0.0.0` when running behind a reverse proxy |

## Docs

- 📖 [使用手册（图文，含截图位）](docs/manual.md) — step-by-step walkthrough of the console.

## Development

```bash
pnpm typecheck      # all packages
pnpm test           # gateway test suite (incl. an upstream→gateway e2e)
pnpm build          # build everything
```

Monorepo: `apps/{mcp-gateway,console-web}`, `packages/{schemas,config}`.

## License

[MIT](LICENSE)
