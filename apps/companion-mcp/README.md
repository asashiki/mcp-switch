# Companion MCP

让当前聊天 AI 拥有可以延续的形象、表情和场景，并用 NovelAI 留下这一幕的 CG。
独立运行的 MCP 服务，位于 MCP Switch monorepo；不向网关内置角色业务，也不需要另配语言模型 API。

## 直接下载运行

[下载独立运行包](../../deliverables/companion-mcp-runtime.tar.gz) · [交付记录与校验值](../../deliverables/README.md) · [工作记录](WORKLOG.md)

运行包已包含服务端依赖和组件，不需要 npm install、pnpm 或编译。需要 Node.js 24+：

```bash
tar -xzf companion-mcp-runtime.tar.gz
cd companion-mcp
cp .env.example .env
# 编辑 .env，将 COMPANION_TOKEN 改成你自己的随机密钥
npm start
```

代码、截图和固定版本运行包都提交在 GitHub 分支中，不依赖聊天沙盒。CI 也会重新打包、启动并验证当前源码，并提供保存 90 天的构建产物；仓库内的运行包与代码不受该 90 天期限影响。

## 已实现

- **形象 / 角色模式**：前者只加视觉形象，后者才返回保存的人设。
- **角色设置页**：人物 Prompt、画风、两类 UC、模型、表情 / 背景上传、JSON 配置导入导出、实际 NAI 请求预览。支持浅色与深色、窄屏。
- **持续场景**：SQLite 保存会话及每轮快照。省略的服装、场景、动作沿用上一轮。新配置只用于新会话。
- **NAI CG**：固定人物、画风和服装，加上本轮表情、动作、构图。异步串行生成，完成后留在原来的那一幕。
- **MCP Apps**：SDK v2 标准桥接、稳定 DOM、无自动发声；已有素材还能以标准 MCP image 内容返回。CG 可用 `get_illustration` 返回图片或链接。
- **防重复付费**：事件去重、每日请求数上限；错误不自动重试；进程中断后不会重发结果不明的请求。

**边界**：固定 Prompt 提高一致性，但不能保证每张 NAI 图完全一致。当前没有参考图条件、自动抠图、Live2D、语音或自动聊天历史同步。MCP 不会监听每条回复，模型必须主动调用演出工具。

## 本地启动

Node 24+，在仓库根目录安装依赖后：

```bash
pnpm install --frozen-lockfile
pnpm --filter @mcp-switch/companion-mcp build
cd apps/companion-mcp
cp .env.example .env
# 编辑 .env，至少替换 COMPANION_TOKEN
pnpm start
```

打开 `http://127.0.0.1:4588/admin`，输入访问密钥。示例爱丽丝只有可编辑 Prompt，**没有假装成已确认素材的占位立绘**；先上传你认可的透明立绘，再保存预览。

最少配置：

| 配置 | 用途 |
| --- | --- |
| 人物 Prompt | 发色、发型、眼睛和不可漂移的外貌特征 |
| 画风 Prompt | 画师串、线稿和上色风格，留空也可以 |
| UC / 人物 UC | 分别限制整体画面和人物的错误元素 |
| `NOVELAI_API_TOKEN` | 仅服务端使用，在 `.env` 配置 |
| `COMPANION_GENERATION_ENABLED=true` | 开启真实生成，否则只预览 |
| `COMPANION_DAILY_LIMIT` | UTC 每日最多提交几次，包括失败和结果不明的请求；不是 Anlas 金额限额 |

示例默认 `nai-diffusion-4-5-full`，模型名可改为你账户实际可用的 API 模型 ID。NAI V4 character-caption 请求结构已实现；其他模型，尤其模型升级后的参数差异，需要实际账户验证。固定限制为单张、最多 28 步、最多 1,048,576 像素，**不保证请求免费**。

`expressions` 映射表情到 Prompt 与可选素材；`scenes` 映射场景到 Prompt 与可选背景；`outfits` 保存服装 Prompt。它们可以在“完整角色配置”编辑。素材存 `/data/assets`（本地为配置的数据目录），导出 JSON 不包含图片或任何密钥。迁移时备份整个数据目录。

## 接入 MCP Switch

在 Switch 控制台“接入”导入：

```json
{
  "mcpServers": {
    "companion": {
      "serverUrl": "http://127.0.0.1:4588/mcp",
      "headers": { "Authorization": "Bearer <COMPANION_TOKEN>" }
    }
  }
}
```

上面的 localhost 仅适用于 **Switch 与 Companion 都作为宿主机进程运行**；两者在 Docker 时使用共享网络服务名，或配置可达的宿主机地址。不要把容器自己的 localhost 当成另一个容器。

使用 `http://companion:4588/mcp` 这样的 Docker 服务地址时，在 Companion 设置 `COMPANION_ALLOWED_HOSTS=companion`。它仅放行精确主机名，仍要求 Bearer 密钥，不会开放任意 Host 或跨域设置页请求。

同步工具后，在 Switch **明确开启并授权写入工具** `open_companion`、`perform_turn`、`request_illustration`（网关默认不会启用新的写工具），再给目标 agent 开可见性。其余读取工具可分别授权。不要把写操作伪装成 read-only 来跳过授权。

在聊天里说：

> 开启爱丽丝陪伴模式。保留你原来的说话方式，用她的形象回应；表情有意义时再更新。先不要生图。

或者：

> 扮演爱丽丝，开启灯塔夜晚场景。接着聊，想留下的片段我会让你画下来。

通过 Switch 使用时，组件轮询使用限定到单个任务的签名只读 URL，不依赖硬编码的上游工具名，因此工具被加上 `rmcp__...` 前缀不会破坏进度更新。

## 远程部署

```bash
# 在仓库根目录；先创建并配置 apps/companion-mcp/.env
# COMPANION_TOKEN 必填；COMPANION_PUBLIC_URL 改成真实 HTTPS origin
# 如 https://companion.example.com

docker compose -f apps/companion-mcp/compose.yaml up -d --build
```

给 Companion 配一个 HTTPS 反向代理，转发到宿主 `127.0.0.1:4588`，保留原始 Host。代理整个服务，包括 `/mcp`、`/admin`、`/api/*`、`/stage`、`/media/*`、`/jobs/*`。图像和任务地址必须能被宿主 iframe 访问，不能填写 VPS 的 localhost。媒体和任务链接使用七天有效的签名；历史链接过期后调用 `get_scene` 或 `get_illustration` 恢复。签名 URL 是限时访问凭据，不要公开转发。

**认证范围**：当前是单人自托管。所有持有同一个服务密钥的连接属于同一个用户，不能把这当成多租户隔离。服务内部会检查 owner，但尚未接入外部多用户身份映射。NAI Token 与 Companion 的访问密钥分开，均不下发组件。

**直连范围**：支持发送 Bearer header 的 MCP 客户端可直连；本地匿名只绑定 loopback。不自行实现第二套 OAuth。ChatGPT / Claude 等需要 OAuth 的远程连接器，应通过已经有 OAuth 的 Switch 接入。没有承诺这些宿主能直接输入一个自定义 Bearer header。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_companions` | 列出可用角色、表情、场景、服装 |
| `open_companion` | 用新的 UUID 事件 ID 开启会话，返回 sessionId |
| `perform_turn` | 一次提交台词与状态，携带当前 revision；同事件可安全重试 |
| `get_scene` | 读取当前或历史快照，刷新素材链接 |
| `request_illustration` | 默认只预览；用户发起绘图后设置 generate=true |
| `get_illustration` | 查询任务及它原本所属的场景；成功时返回图片 |

生成任务保存完整请求，便于复现；不发送整段私聊或人设文字给 NAI。Prompt 只来自视觉配置、动作与构图。请勿把敏感信息放进这些字段。

不支持 Apps 的客户端会拿到文字与可用的图片内容；具体是否显示图片仍取决于宿主。已有立绘缺失时明确回退到默认立绘或文字，不临时生成假立绘。

## 验证

```bash
pnpm --filter @mcp-switch/companion-mcp typecheck
pnpm --filter @mcp-switch/companion-mcp test
pnpm --filter @mcp-switch/companion-mcp build
```

测试包括真实 HTTP 服务 → 真实 Switch 网关 → SDK 客户端，新版 2026-07-28 与旧版协议均覆盖。NAI provider 测试使用官方 JSON 返回格式的模拟响应，**不代表已经实际调用 NAI 出图**。详见 [验证记录](VALIDATION.md)。

运行一个进程 / 一个 SQLite 数据目录；不要用多个副本共同消费队列。备份或迁移前停止服务，并复制整个数据目录（含 SQLite、WAL、素材与签名密钥）。

## 技术依据

- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)：请求状态与应用状态分离；本项目以 SQLite 保存业务状态。
- [MCP Apps SDK](https://apps.extensions.modelcontextprotocol.io/api/)：标准工具 / UI 资源注册及宿主桥接。
- [OpenAI MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui)：组件依托宿主渲染，不控制整个聊天界面。
- [NovelAI 官方 API](https://image.novelai.net/docs/index.html)：使用 `/ai/generate-image`，请求 JSON 图片响应；不自动重试付费请求。
- [sticker-mcp](https://github.com/asashiki/sticker-mcp)：参考它的内联图片和工具引导思路；这里重新实现状态、组件和生成服务。
