# 2026 部署与远程测试选择

更新日期：2026-08-30。

MCP Switch 同时依赖长期运行的 Node 进程、SQLite、可选 stdio 子进程和旧版 MCP 的流式连接。判断一个平台能不能部署，不能只看“能不能跑一个 HTTP Handler”，还要看状态是否持久、能否启动子进程、长连接是否完整、外部 URL 是否稳定。

## 先给结论

| 方案 | 费用 | 远程 ChatGPT 测试 | stdio 上游 | SQLite 持久化 | 结论 |
|---|---:|---|---|---|---|
| 本机 Docker | 0 | 不能直接回连 | 支持 | 本地 volume | 适合开发、App Lab、协议回归 |
| 本机 + named Cloudflare Tunnel | 可用免费计划 | 支持，稳定 HTTPS 域名 | 支持 | 本地 volume | **最佳零成本 canary**，但本机必须在线 |
| VPS 第二套 Compose project | 已有 VPS 成本 | 支持 | 支持 | 独立 volume | **最佳完整验收与最终升级方式** |
| Oracle Always Free VM | 0，取决于区域容量 | 支持 | 支持 | 支持 | 可作为独立免费测试机，ARM 依赖需验证 |
| Google Cloud Run | 低流量可能落在免费额度 | 支持 | 同镜像内理论可启动 | **实例回收即丢失** | 只适合临时无状态烟测，不能原样用于生产 |
| Cloudflare Containers | 至少 Workers Paid，当前无 Free 档 | 支持 | 容器内支持 | **容器磁盘默认临时** | 要先迁移持久状态，不是“白嫖部署” |
| Cloudflare Workers | 有免费档 | 支持 | 不支持 | 必须改为 D1/DO | 当前项目不能原样部署，只能另做 remote-only Edge 版 |

首选顺序是：本地跑通 → named Tunnel 做真实 ChatGPT canary → VPS 蓝绿切换。这样不会碰正在工作的老版本，也不会为了试用先做一次云平台重写。

## 1. 本地验证到底有没有价值

有。MCP Switch 本地版和公网版使用相同的协议处理器，本地可以完整验证：

- MCP 2026 与 MCP 2025 双栈；
- HTTP 与 stdio 上游发现；
- schema、annotations、`structuredContent` 和 MCP Apps 元数据转发；
- OAuth 关闭时的匿名开发模式；
- 控制台 App Lab、组件布局和 bridge 消息；
- 长连接复用、重启、SQLite 迁移与回归测试。

本地测试缺的不是性能，而是网页端宿主无法访问 `127.0.0.1`。要在 ChatGPT、claude.ai 等网页端完成真实 OAuth 和组件加载，必须再给它一个稳定的公网 HTTPS URL。

```bash
cp .env.example .env.local-test
docker compose -p mcp-switch-local \
  -f infra/docker/compose.yaml \
  --env-file .env.local-test up -d --build

pnpm check:remote -- --url http://127.0.0.1:4577
```

远程检查器不会调用任何真实工具。它只读取 `/health`、OAuth metadata、工具/资源目录和工具已链接的 UI 资源，并分别建立 MCP 2026 与 MCP 2025 连接。

## 2. 零成本远程 canary：named Cloudflare Tunnel

Cloudflare Tunnel 只是公网入口，计算和数据仍在本机。它的优势是稳定域名、自动 HTTPS，以及不需要开放家里路由器端口。Cloudflare 当前仍提供 Zero Trust 免费计划；named tunnel 与 Quick Tunnel 不是一回事。

### 配置

1. 在 Cloudflare 控制台创建一个单独的 remotely-managed tunnel，例如 `mcp-switch-canary`。
2. 添加 Public Hostname，例如 `mcp-canary.example.com`。
3. Origin Service 填 `http://mcp-switch:4577`。这是 Compose 内部服务名，不是 `localhost`。
4. 复制 tunnel token，只放进本机文件，不写进 `.env` 或 Git：

```bash
mkdir -p infra/docker/.secrets
# 把 token 单独保存为：
# infra/docker/.secrets/cloudflare-tunnel-token.txt
chmod 600 infra/docker/.secrets/cloudflare-tunnel-token.txt
```

5. 创建 canary 环境文件并换成真实测试域名：

```bash
cp .env.vps.example .env.canary
```

6. 启动独立 project：

```bash
docker compose -p mcp-switch-canary \
  -f infra/docker/compose.yaml \
  -f infra/docker/compose.tunnel.yaml \
  --env-file .env.canary up -d --build
```

`mcp-switch-canary` project 会得到自己的容器、网络和 `mcp_switch_data` volume；宿主端口是 4578，旧实例完全不参与。`compose.tunnel.yaml` 通过 Docker secret 文件把 token 提供给 cloudflared，并保持只读根文件系统、无 Linux capabilities。

### 验收

没有 Bearer token 时，可以先检查公开面和 OAuth challenge：

```bash
pnpm check:remote -- \
  --url https://mcp-canary.example.com \
  --allow-partial
```

若已有只读测试 token，用环境变量或权限受限的文件提供，避免写进 shell 参数和历史：

```bash
MCP_CHECK_TOKEN='短期测试 token' pnpm check:remote -- \
  --url https://mcp-canary.example.com

pnpm check:remote -- \
  --url https://mcp-canary.example.com \
  --token-file /absolute/private/path/canary-token
```

完整通过应包括：

- `/health` 可达；
- OAuth Protected Resource Metadata 的 `resource` 精确等于 `https://mcp-canary.example.com/mcp`；
- 401 带 `resource_metadata` 的 Bearer challenge；
- 自动协商到 `2026-07-28`；
- 旧客户端仍进入 legacy era；
- 新旧客户端看到相同工具与资源目录；
- 每个 UI 资源可读、MIME 为 `text/html;profile=mcp-app`；
- 标准 `ui.resourceUri` 与 OpenAI 兼容 alias 不冲突；
- 检测到标准 MCP Apps bridge，而不只是 `window.openai`。

最后仍要在 ChatGPT 中新建一条只指向 canary URL 的连接，走一遍真实 OAuth，然后实际播放一首歌。自动检查器故意不调用工具，所以它不能代替最终的音频播放、CSP、Range 和宿主 UI 验收。

### 为什么不使用 Quick Tunnel

Quick Tunnel 适合几分钟的普通网页演示，但官方明确说明：随机 `trycloudflare.com` URL、无 SLA、最多 200 个并发中的请求，而且不支持 SSE。随机 URL 还会破坏 MCP Switch 的 canonical OAuth resource 绑定。它最多用于 MCP 2026 请求/响应烟测，不应用于完整的旧协议、OAuth 或 MCP Apps 验收。

## 3. VPS 蓝绿 canary

这是与正式环境最接近的方案。不要升级旧容器，也不要让两版共用一个 SQLite 文件。

```bash
docker compose -p mcp-switch-canary \
  -f infra/docker/compose.yaml \
  --env-file .env.canary up -d --build
```

为 canary 配置独立子域名和反向代理，数据库从生产库用 SQLite `VACUUM INTO` 做一致性副本。完成 ChatGPT、Claude 和本地检查器验证后，只切反向代理；回滚时切回旧 upstream 即可。完整步骤见 [deployment-and-upgrade.zh-CN.md](./deployment-and-upgrade.zh-CN.md)。

## 4. Cloudflare Containers 与 Workers

### Containers

Cloudflare Containers 当前没有免费档，要求至少 $5/月的 Workers Paid 计划。计费页列出的套餐内额度适合低频 canary，但容器磁盘默认是临时的，休眠或重启后不能依赖 `/data/mcp-switch.sqlite` 仍然存在。Durable Object 确实提供持久 SQLite 存储，但它不是容器里的普通文件，现有 `node:sqlite` 数据访问层不能直接指向它。

因此要上 Containers，至少需要一层状态迁移：

- 把 agent、OAuth、registry、audit 从本地 SQLite 抽象成 Durable Object/D1 backend；
- 处理容器休眠后的上游 runtime 恢复；
- 为 stdio 上游规定镜像内命令白名单；
- 验证旧版 SSE 与容器睡眠/唤醒行为；
- 把单实例语义改成明确的 routing key，避免同一 OAuth 状态落到不同实例。

这可以做成未来的 `Switch Edge`，但不是当前 canary 的最低风险路径。

### Workers

Cloudflare Workers 2026 年的 Node 兼容性比以前强，但官方兼容表仍把 `node:child_process` 和 `node:sqlite` 列为“可导入但不可工作的 stub”。Workers 的文件系统也是每个请求隔离环境中的内存虚拟文件系统。当前 MCP Switch 依赖这三项，因此不能把现有 Docker 应用直接部署成 Worker。

如果未来做 Worker 版，它应明确缩小为：只代理远程 HTTP MCP、使用 D1/Durable Objects、没有 stdio 子进程、运行时连接状态可重建。它应与完整版共享协议与 metadata 测试，但不是用条件分支硬塞进同一进程。

## 5. Cloud Run 与 Oracle Always Free

Cloud Run 请求计费模式当前每月有 180,000 vCPU-seconds、360,000 GiB-seconds 和 200 万请求免费额度，低流量 canary 很可能不产生计算费用，但项目仍需启用 billing。更关键的是，Cloud Run 官方说明实例的 ephemeral disk 在崩溃、缩容或新 revision 切流时会永久删除；这与 MCP Switch 的 SQLite/OAuth 状态不兼容。

Cloud Run 可以用于一次性的匿名/预置配置烟测。若要支持真实 OAuth，必须先外置状态，并解决多实例一致性；只设置 `max-instances=1` 也不能让临时磁盘变成持久盘。

Oracle Always Free VM 更接近小 VPS：能运行 Docker、持久磁盘和 stdio。官方当前文档给出的 Always Free Ampere 总额度为最多 2 OCPU、12 GB RAM，但热门区域可能没有可分配容量。若使用 ARM 实例，必须重新构建 arm64 镜像并逐个验证包含 native binary 的 stdio MCP。

## 官方依据

- [Cloudflare Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel run 参数与 token-file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
- [Cloudflare Tunnel account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- [Cloudflare Containers 价格](https://developers.cloudflare.com/containers/platform/pricing/)
- [Cloudflare Containers 生命周期与临时磁盘](https://developers.cloudflare.com/containers/reference/container-class/)
- [Cloudflare Workers Node.js 兼容表](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Google Cloud Run 价格与免费额度](https://cloud.google.com/run/pricing)
- [Google Cloud Run ephemeral disk](https://docs.cloud.google.com/run/docs/configuring/services/ephemeral-disk)
- [Google Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Oracle Cloud Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
