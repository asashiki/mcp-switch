<div align="center">

# MCP Switch

**用一个自托管端点接入所有本地与远程 MCP。**

![license](https://img.shields.io/badge/license-MIT-e96ba8)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![status](https://img.shields.io/badge/status-beta-8b8bef)

[English](README.md) · **简体中文** · [日本語](README.ja.md)

🔗 **[在线控制台演示](https://show.asashiki.com/console/)** · 📖 **[使用手册](docs/manual.md)**

</div>

---

## 为什么

Web/App 端的 AI 只能连**远程** MCP，而且大多只给你**一个**自定义连接器名额；
可很多有用的 MCP 是**本地** stdio 进程（`npx`/`uvx`），只有 Claude Desktop / CLI 能拉起。

MCP Switch 夹在中间：

```
   本地 stdio MCP   ─┐
                    ─┼──►  MCP Switch  ──►  一个 OAuth URL  ──►  claude.ai / ChatGPT / …
   远程 HTTP MCP    ─┘     (你的 VPS)
```

- **聚合**任意多个 MCP——远程（URL）或本地（stdio，在你机器上托管）——到一个端点。
- **连一次。** 你的 AI 只看到一个连接器，背后是你所有的工具。
- **控制台管理**——加服务器、给工具分组、按 agent 限定可见性、看审计日志。
- **WebMCP 控制面。** 支持它的浏览器智能体可以查看脱敏状态、打开 App Lab、准备待审接入草稿。
- **纯中转。** MCP Switch 自身不带任何工具；它原样转发工具、schema、结果，乃至 MCP Apps 的 UI 组件。

## 架构

**单服务**（`:4577`）+ 它自带托管的控制台 SPA：

| 部件 | 职责 |
|---|---|
| MCP 网关 | 公开 MCP 端点（`/mcp`）、OAuth 2.1、管理控制台（`/console`） |
| Registry | 进程内连接上游 MCP 服务器——远程（HTTP）和本地（stdio） |
| Store | 一份 SQLite：agents、OAuth、审计、技能注册表、服务器注册表 |

没有独立后端、没有服务间 HTTP——网关直接连上游并聚合。

## 快速开始（Docker）

```bash
git clone https://github.com/asashiki/mcp-switch.git
cd mcp-switch
cp .env.example .env
# 编辑 .env → 设 MCP_PUBLIC_URL 开启 OAuth + 控制台（留空 = 本地匿名）

docker compose -f infra/docker/compose.yaml --env-file .env up -d --build
```

然后：

- 健康检查：`curl http://127.0.0.1:4577/health`
- 控制台：打开 `http://127.0.0.1:4577/console`（先设密码，见下）

> 反向代理与 Switch 在同一台 VPS 时，只需设置 `MCP_PUBLIC_URL`，宿主端口继续绑定 `127.0.0.1`。

### 设置控制台密码

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin "你的密码"
```

## 快速开始（本地开发）

```bash
pnpm install
cp .env.example .env          # MCP_PUBLIC_URL 留空 → 匿名本地 /mcp
pnpm dev                      # 网关 :4577 + 控制台 :5173
```

没设 `MCP_PUBLIC_URL` 时，网关提供匿名 `/mcp`——方便在接 OAuth 前先本地试玩。

## 接入一个 AI

claude.ai → 设置 → 连接器 → **添加自定义连接器**，指向：

```
https://<你的 MCP_PUBLIC_URL>/mcp
```

完成 OAuth 登录（在同意页选一个 agent 身份）。聚合后的工具就会出现在客户端里。

## 添加上游 MCP 服务器

打开控制台 → **接入**。两种方式：

**远程（HTTP）。** 粘贴服务器 URL；需要鉴权就加 header（如 API key）或 OAuth。例——Context7：

```json
{ "mcpServers": { "context7": {
  "serverUrl": "https://mcp.context7.com/mcp",
  "headers": { "CONTEXT7_API_KEY": "..." }
}}}
```

**本地（stdio）。** MCP Switch 在你的服务器上拉起进程，再远程暴露它。例——用 `npx` 跑 Steam MCP：

```json
{ "mcpServers": { "steam": {
  "command": "npx",
  "args": ["-y", "steam-mcp-server"],
  "env": { "STEAM_API_KEY": "..." }
}}}
```

把任一 JSON 直接粘进控制台的导入框——会自动识别 transport 并填好表单。镜像内置 Node/`npx`；
要跑 `uvx`/Python 的服务器，需在镜像里加对应运行时。

## 配置

全部通过 `.env`（见 [`.env.example`](.env.example)）：

| 变量 | 作用 |
|---|---|
| `MCP_PUBLIC_URL` | 公网 origin；**设了才开 OAuth + 控制台**，留空 = 匿名本地 `/mcp` |
| `MCP_AUTH_DB_PATH` | 本地开发的 SQLite 路径；Docker 固定写入 `/data` volume |
| `MCP_OAUTH_SCOPE` | 对客户端广告的 OAuth scope |
| `MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION` | 旧客户端过渡开关；重新授权完成后关闭 |
| `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` | 可选的传输层白名单；留空会从公网 URL 推导 |
| `REMOTE_MCP_SERVERS_JSON` | 可选：预置上游服务器，省去用控制台添加 |
| `MCP_GATEWAY_HOST` | 本地开发监听地址；Docker 会安全地覆盖容器内监听值 |
| `MCP_GATEWAY_BIND_HOST` | 宿主机发布地址；同机反代默认保持 `127.0.0.1` |

## 文档

- [VPS 部署交接单](docs/VPS-DEPLOY.zh-CN.md) —— 可以直接交给服务器上的 AI 执行。
- [使用手册](docs/manual.md) —— 控制台操作。
- [安全升级与回滚](docs/deployment-and-upgrade.zh-CN.md) —— 并行部署、验证与回滚。
- [MCP Apps App Lab](docs/mcp-apps-app-lab.zh-CN.md) —— 组件兼容诊断。
- [WebMCP 控制面](docs/webmcp-control-plane.zh-CN.md) —— 五个受限的页面工具。
- [文章资料包](docs/blog/MCP-SWITCH-ARTICLE-KIT.zh-CN.md) 与 [第一人称草稿](docs/blog/MCP-SWITCH-ARTICLE-DRAFT.zh-CN.md)。

## 开发

```bash
pnpm typecheck      # 全部 package
pnpm test           # 网关测试套件（含 上游→网关 端到端）
pnpm build          # 全量构建
```

Monorepo：`apps/{mcp-gateway,console-web}`、`packages/{schemas,config}`。

## 许可证

[MIT](LICENSE)
