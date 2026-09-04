# VPS 部署交接单

这份说明用于在已有旧版 MCP Switch 的 VPS 上再启动一套新版。下面假定旧版占用
`4577`，新版使用 `4578`。两套实例不共用 Compose project、端口或 SQLite volume。

## 交给 VPS 上的 AI

可以把这一段原样发给它：

> 在这台 VPS 上并行部署 `asashiki/mcp-switch` 的 `main` 分支。不要停止、重建或修改
> 现有 MCP Switch。新实例使用 Compose project `mcp-switch-next`、宿主端口 `4578`、
> 独立 volume 和新的子域名。先检查端口、磁盘、Docker/Compose 与现有反向代理，再按
> `docs/VPS-DEPLOY.zh-CN.md` 执行。部署后回报 commit SHA、容器健康状态、实际配置文件
> 路径、反向代理配置、健康检查结果；不要在回复里显示密码、Token 或 `.env` 内容。

## 1. 检查并准备代码

```bash
docker version
docker compose version
ss -lntp | grep -E ':4577|:4578' || true
df -h

git clone https://github.com/asashiki/mcp-switch.git mcp-switch-next
cd mcp-switch-next
git switch main
git pull --ff-only origin main
git rev-parse HEAD

cp .env.vps.example .env.next
chmod 600 .env.next
```

编辑 `.env.next`，至少替换 `MCP_PUBLIC_URL`。同机反向代理时保持：

```dotenv
MCP_GATEWAY_HOST_PORT=4578
MCP_GATEWAY_BIND_HOST=127.0.0.1
```

不要把密码、OAuth secret、Bearer token 或上游 Header 提交进 Git。

## 2. 构建并启动第二套实例

先展开 Compose 配置，确认端口是 `127.0.0.1:4578`，volume 名包含
`mcp-switch-next`：

```bash
docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml config

docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml up -d --build

docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml ps

curl --fail --show-error http://127.0.0.1:4578/health
```

设置新版控制台密码：

```bash
docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin '换成新的强密码'
```

## 3. 接入域名并验收

给新子域名增加反向代理，upstream 指向 `http://127.0.0.1:4578`。必须保留原始
`Host` 与 `X-Forwarded-Proto: https`，关闭响应缓冲，并给流式请求足够长的超时。
不要改旧域名的 upstream。

```bash
docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/remote-check.js \
  --url https://mcp-next.example.com --allow-partial
```

然后完成四项人工检查：

1. 新域名的 `/console/` 可以登录，旧域名仍正常。
2. 添加一个远程 HTTP MCP，发现工具并在 Skills 中启用。
3. 新建测试 Agent，让 ChatGPT 或 Claude 只连接新域名并完成 OAuth。
4. 在 App Lab 检查带 UI 的上游；最后实际调用一次只读工具。

`--allow-partial` 只适合没有测试 Token 时检查公开端点和 OAuth challenge。拿到只读
测试 Token 后，应再跑一次完整检查。Token 用环境变量或权限受限文件提供，不要写进命令历史。

## 停止新版

```bash
docker compose -p mcp-switch-next \
  --env-file .env.next \
  -f infra/docker/compose.yaml down
```

不要加 `-v`，否则会删除新版数据卷。这个命令不会操作旧版 Compose project。

需要复制旧版配置时，先按[安全升级与回滚](deployment-and-upgrade.zh-CN.md)用 SQLite
`VACUUM INTO` 做一致性备份，再把副本导入新 volume；不要让两套实例写同一个数据库文件。
