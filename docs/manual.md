<div align="center">

# MCP Switch 使用手册

**一个 MCP 端点，聚合你所有本地 + 远程 MCP 服务器。**

</div>

> 截图位用 `> 📸 …` 标出，对应 `docs/img/` 下的文件名，自己截图后放进去即可（占位图不存在时这一行不显示图，不影响阅读）。

---

## 目录

1. [它能帮你做什么](#1-它能帮你做什么)
2. [5 分钟跑起来](#2-5-分钟跑起来)
3. [登录控制台](#3-登录控制台)
4. [概览页](#4-概览页)
5. [接入上游 MCP 服务器](#5-接入上游-mcp-服务器)
6. [技能页：决定暴露哪些工具](#6-技能页决定暴露哪些工具)
7. [Agents：身份与分权](#7-agents身份与分权)
8. [把 AI 接上来](#8-把-ai-接上来)
9. [审计](#9-审计)
10. [常见问题](#10-常见问题)

---

## 1. 它能帮你做什么

Web/App 端的 AI（claude.ai、ChatGPT…）通常**只能连一个远程 MCP 连接器**，而很多好用的 MCP 是**本地 stdio 进程**（`npx`/`uvx`），只有桌面端/CLI 能跑。

MCP Switch 夹在中间：

```
   本地 stdio MCP  ─┐
   远程 HTTP MCP   ─┼──►  MCP Switch  ──►  一个 OAuth URL  ──►  claude.ai / ChatGPT / …
   再一个 MCP      ─┘     (你的服务器)
```

- **聚合**任意多个 MCP（远程 URL 或本地 stdio）到一个端点。
- **连一次**，AI 就能用上背后所有工具。
- **控制台管理**：加服务器、分组、按 agent 分权、看审计。
- **纯中转**：MCP Switch 自身不带工具，原样转发上游的工具、schema、结果，连 MCP Apps 的 UI 组件也透传。

---

## 2. 5 分钟跑起来

### Docker（推荐）

```bash
git clone https://github.com/asashiki/mcp-switch.git
cd mcp-switch
cp .env.example .env
# 编辑 .env：设 MCP_PUBLIC_URL 开启 OAuth + 控制台（留空 = 本地匿名模式）

docker compose -f infra/docker/compose.yaml --env-file .env up -d --build
```

验证：

```bash
curl http://127.0.0.1:4200/health
```

> 反代后部署：`.env` 里设 `MCP_PUBLIC_URL=https://mcp.example.com` 和 `MCP_GATEWAY_BIND_HOST=0.0.0.0`，反代把 `/mcp`、`/console`、`/api/console/*`、OAuth 端点转发到容器 `:4200`。

### 本地试玩（不用 OAuth）

```bash
pnpm install
cp .env.example .env      # MCP_PUBLIC_URL 留空
pnpm dev                  # gateway :4200 + 控制台 :5173
```

---

## 3. 登录控制台

先设管理员密码：

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin "你的密码"
```

打开 `http://127.0.0.1:4200/console`（或你的 `MCP_PUBLIC_URL/console`），用 `admin` + 刚设的密码登录。

> 📸 登录页 —— `docs/img/01-login.png`
>
> ![登录页](img/01-login.png)

---

## 4. 概览页

登录后默认进概览，一眼看清：本期调用量、P95 延迟、错误/拦截、活跃 agent，外加工具排行、agent 占比、最近异常、系统健康（`mcp-switch :4200` + 各上游连接器状态）。每 30 秒自动刷新。

> 📸 概览页 —— `docs/img/02-overview.png`
>
> ![概览页](img/02-overview.png)

---

## 5. 接入上游 MCP 服务器

进 **接入** 页。两种上游，可在表单顶部切换 **远程 / 本地**，也可以直接往导入框粘 JSON 自动识别。

### 方式 A：远程（HTTP）

填服务器 URL；需要鉴权就加 header（如 API key）或走 OAuth。

```json
{ "mcpServers": { "context7": {
  "serverUrl": "https://mcp.context7.com/mcp",
  "headers": { "CONTEXT7_API_KEY": "..." }
}}}
```

> 📸 添加远程服务器 —— `docs/img/03-add-remote.png`
>
> ![添加远程服务器](img/03-add-remote.png)

### 方式 B：本地（stdio，本机接管）

MCP Switch 会在你的服务器上拉起这个进程，再远程暴露它。

```json
{ "mcpServers": { "steam": {
  "command": "npx",
  "args": ["-y", "steam-mcp-server"],
  "env": { "STEAM_API_KEY": "..." }
}}}
```

> 镜像内置 Node/`npx`；要跑 `uvx`/Python 的 stdio 上游，需在 Dockerfile 里加对应运行时。

> 📸 添加本地 stdio 服务器 —— `docs/img/04-add-stdio.png`
>
> ![添加本地服务器](img/04-add-stdio.png)

### 方式 C：直接粘 JSON

把上面任一段 JSON 粘进导入框，会自动识别 transport（remote/stdio）并填好表单。

> 📸 JSON 导入框 —— `docs/img/05-json-import.png`
>
> ![JSON 导入](img/05-json-import.png)

添加后会**自动发现**上游的工具并 seed 进技能注册表（**默认全部禁用**，需要你在技能页开）。卡片上能看到 status / 工具数 / lastError，以及「查看 JSON 配置」回显（仅键名，密钥值不外泄）。

> 📸 上游服务器卡片 —— `docs/img/06-server-card.png`
>
> ![服务器卡片](img/06-server-card.png)

---

## 6. 技能页：决定暴露哪些工具

进 **技能** 页。工具按「所属上游服务器」分组，组可折叠，组头有总开关。每个工具显示标题/描述 + 启用开关，并带 本地/远程 标签。

- **启用开关**：打开后这个工具才会出现在 AI 的工具列表里。
- **允许写入**：远程**写工具**默认 OFF，需要额外打开这个开关才会暴露（`allowWrite` 会透传给上游）。只读工具没有这个开关。
- 改完开关后，**已连接的 AI 客户端需重连**才会刷新工具列表（协议限制推不了变更，控制台会提示）。

> 📸 技能页（分组 + 开关）—— `docs/img/07-skills.png`
>
> ![技能页](img/07-skills.png)

---

## 7. Agents：身份与分权

进 **Agents** 页。每个 agent 是一个独立的 OAuth 身份。

- **新建**：弹出一次性密钥，记得复制保存（只显示这一次）。
- **启停 / 轮换密钥**：禁用会吊销该 agent 的所有 token。
- **工具可见性**（白名单）：给某个 agent 只露指定的几个工具——空 = 继承全部启用的工具；非空 = 只给白名单里的。不用为此拆出多个 URL。

> 📸 Agents 页 —— `docs/img/08-agents.png`
>
> ![Agents 页](img/08-agents.png)
>
> 📸 新建 agent 的一次性密钥 —— `docs/img/09-agent-secret.png`
>
> ![一次性密钥](img/09-agent-secret.png)

---

## 8. 把 AI 接上来

以 claude.ai 为例：Settings → Connectors → **Add custom connector**，地址填：

```
https://<你的 MCP_PUBLIC_URL>/mcp
```

走 OAuth 登录，在同意页选一个 agent 身份。完成后，这个 AI 就看到**一个**连接器，背后是你聚合并启用的所有工具。ChatGPT 等其他客户端同理，都只需这一个远程 URL。

> 📸 在 claude.ai 添加自定义连接器 —— `docs/img/10-connect-claude.png`
>
> ![添加连接器](img/10-connect-claude.png)
>
> 📸 OAuth 同意页（选 agent 身份）—— `docs/img/11-oauth-consent.png`
>
> ![OAuth 同意](img/11-oauth-consent.png)

---

## 9. 审计

进 **审计** 页，按时间倒序看每一次请求：时间 / 动作 / agent / 成功与否 / 详情。排查「某个工具调用为什么失败」「谁在用」时看这里。

> 📸 审计页 —— `docs/img/12-audit.png`
>
> ![审计页](img/12-audit.png)

---

## 10. 常见问题

**Q：加了工具，AI 端看不到？**
先确认技能页里该工具**已启用**；然后**让 AI 客户端重连**（断开再连接器）——工具列表只在连接时拉取一次。

**Q：写操作被拒？**
远程写工具默认不暴露。去技能页打开该工具的「允许写入」开关。

**Q：本地 stdio 上游加了不工作？**
确认镜像里有对应运行时（Node/`npx` 内置；`uvx`/Python 要自己加进 Dockerfile）。看上游卡片的 `lastError` 和审计页。

**Q：必须用 OAuth 吗？**
不。`.env` 里 `MCP_PUBLIC_URL` 留空时，`/mcp` 是匿名开放的，适合本地试玩。设了它才开 OAuth + 控制台，用于生产。

**Q：上游需要它自己的 OAuth（比如某些 SaaS MCP）怎么办？**
在接入页对该服务器发起授权，token 会安全落库由 MCP Switch 持有，不暴露给下游 AI。

---

<div align="center">

需要更细的部署/架构说明，见仓库 [`README.md`](../README.md)。

</div>
