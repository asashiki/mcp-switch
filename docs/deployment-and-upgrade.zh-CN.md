# MCP Switch 安全升级、试用与回滚

这份流程的目标不是在正在使用的 VPS 实例上“原地赌一次”，而是先复制数据、并行启动候选版本、完成真实客户端验证，再决定是否切流量。

本机公网测试、Cloudflare Tunnel、Cloud Run/Containers 与免费 VM 的取舍见 [2026 部署与远程测试选择](./deployment-options-2026.zh-CN.md)。仓库同时提供 `pnpm check:remote`，用于只读检查公网 canary 的 OAuth、双协议目录和 MCP Apps 资源。

## 1. 本地无认证试玩

本地模式可以完整测试网关、控制台、远程 HTTP 上游和本机可运行的 stdio 上游。它与部署在公网的协议实现相同；区别只是没有公网 HTTPS URL，因此 ChatGPT、claude.ai 等网页端不能直接回连。

```bash
cp .env.example .env.local-test
# MCP_PUBLIC_URL 保持为空
docker compose -f infra/docker/compose.yaml --env-file .env.local-test \
  -p mcp-switch-local up -d --build
curl http://127.0.0.1:4577/health
pnpm check:remote -- --url http://127.0.0.1:4577
```

本轮容器默认以非 root 用户运行、根文件系统只读，并丢弃 Linux capabilities。`npx` 的临时下载写入 `/tmp`；需要持久写文件的 stdio MCP 应显式挂载一个专用目录，不能依赖写入应用目录。

停止试玩：

```bash
docker compose -f infra/docker/compose.yaml --env-file .env.local-test \
  -p mcp-switch-local down
```

不要加 `-v`，这样不会顺带删除测试数据卷。

## 2. VPS 并行 canary，不覆盖旧版

先记录旧容器使用的镜像、提交号、端口、域名和数据卷。对 SQLite 做一致性备份；不要直接复制仍在写入的数据库文件。

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MCP_AUTH_DB_PATH||'/data/mcp-switch.sqlite');db.exec(\"VACUUM INTO '/data/mcp-switch-before-upgrade.sqlite'\");db.close()"
```

把备份文件复制到一个新的 canary 数据卷或目录。候选版本使用：

- 独立的 Compose project 名；
- 独立 SQLite 副本；
- 独立宿主端口；
- 独立测试子域名与反向代理路由；
- 新建的测试 agent/client，不复用生产 access token。

示例 `.env.canary`：

```dotenv
MCP_PUBLIC_URL=https://mcp-canary.example.com
MCP_GATEWAY_HOST_PORT=4578
MCP_GATEWAY_BIND_HOST=127.0.0.1
MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION=true
```

```bash
docker compose -f infra/docker/compose.yaml --env-file .env.canary \
  -p mcp-switch-canary up -d --build
```

若使用 named Cloudflare Tunnel，可叠加 `infra/docker/compose.tunnel.yaml`；具体 token-file 和域名配置见部署选择文档。

canary 的 `MCP_PUBLIC_URL` 必须与客户端实际连接的 canonical `/mcp` URL 一致，否则 RFC 8707 resource/audience 校验会正确拒绝 token。

## 3. OAuth 迁移顺序

新版本会给 authorization code、access token 和 refresh token 绑定具体的 `https://<host>/mcp` resource。数据库迁移仅增加可空列，旧数据不会被删除。

1. 首次启动保持 `MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION=true`，让旧客户端的未绑定 token 有短暂过渡期。
2. 逐个在 ChatGPT、Claude 等客户端中断开并重新授权，使新 token 带 resource。
3. 从审计记录确认旧连接已退出。
4. 设置 `MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION=false` 并重启，进入严格模式。

严格模式下，授权请求与 token 请求都必须携带匹配的 `resource`；写工具还必须具备 `tools:write` scope。

## 4. 必测清单

- 新版 2026 客户端和旧版 2025 客户端都能连接同一 `/mcp`。
- 同一 stdio 上游连续调用不会每次重复启动两次进程。
- 复杂 input/output JSON Schema、图片/音频结果和 tool annotations 没有丢失。
- ChatGPT/标准 MCP Apps 宿主能加载组件；组件失败时工具仍返回可读的无 UI 结果。
- 控制台「接入 → App Lab」能识别 UI tools、标准 bridge、MIME/CSP，并在手动点击后显示隔离预览。
- 只读 agent 看不到写工具，直接调用写工具得到带 `insufficient_scope` 的 403。
- 错误 Host/Origin 被拒绝；正确反代域名可用。
- 容器重启后 SQLite、agent、上游配置和 OAuth 状态仍存在。

## 5. 回滚

在 canary 阶段回滚只需停止 canary，旧实例从未被修改。正式切流后若需回滚：

1. 将反向代理流量切回旧容器；
2. 使用升级前的 SQLite 备份启动旧版；
3. 撤销升级期间新签发的 token，要求客户端重新授权；
4. 保留失败实例和日志用于排查，不要立即删除数据卷。

不要让新旧两个实例同时写同一个 SQLite 文件。即使新增列对旧代码兼容，共享写入仍可能造成 token 状态与审计记录竞争。
