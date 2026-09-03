# MCP Switch 文章资料包

更新时间：2026-09-03

这份资料对应 `mcp-switch` Draft PR #4 与叠加在它上面的 Draft PR #6。它把已经完成的代码、仍需实机确认的部分、官方协议变化、截图顺序和可直接使用的文案放在一起。写文章时不必全部照搬。

## 一句话说明项目

MCP Switch 是一个自托管 MCP 网关：把本地 stdio 和远程 HTTP MCP 收进同一个 `/mcp` 入口，再统一处理新旧协议兼容、OAuth、Agent 权限、审计和 MCP Apps UI。

WebMCP 是新加入的控制面。它让 AI 在你已经打开控制台时读取脱敏状态、定位服务器、打开 App Lab 或准备一份接入草稿；保存、授权和删除仍由人点击确认。

## 文章最适合抓住的矛盾

可以从一句很诚实的话开始：最近 MCP 的热度明显下去了。

这里不要写「MCP 已死」或虚构使用量数据。真正值得写的是：热度下去以后，留下来的麻烦反而更具体。一个人同时使用 ChatGPT、Claude、Codex，再加上几个自己写的 MCP Server，很快会遇到重复配置、协议版本、OAuth、工具权限和 UI 宿主兼容问题。MCP Switch 处理的就是这些不够吸引眼球、但实际使用时躲不开的问题。

文章的主线可以是：

> 我原本只想把多个 MCP 合成一个 URL，后来发现真正需要的是一层能够兼容、隔离、诊断和让人随时接管的网关。

## 可选标题

首选：

- 《MCP 已经没人聊了，我还是把自己的 MCP 网关重做了一遍》

更偏项目介绍：

- 《MCP Switch：我不想在每个 AI 客户端里再配一遍 MCP》
- 《从多个 MCP 合成一个 URL，到一个真正能用的自托管网关》

更偏技术：

- 《MCP 2026-07-28 之后，网关要解决什么问题》
- 《MCP、MCP Apps、WebMCP：三个相似名字到底分别在做什么》

## 建议结构

### 1. 为什么还要做

可用事实：

- VPS 上的旧版一直能用，没有为了升级而强行停掉。
- MCP 多起来以后，每个客户端都要重复配置。问题就出在这里。
- 本地 stdio、远程 HTTP、只读工具、写工具和带 UI 的工具并不处在同一个风险等级。
- 热度下降不等于已有使用场景自动消失。

### 2. 2026 版协议改变了什么

官方 2026-07-28 规范把基础请求改为 stateless、self-contained，并使用 per-request capability negotiation。可以把它解释成：新版更接近普通 HTTP 基础设施，但业务消息仍然是 MCP/JSON-RPC，不是退回 REST。

对网关最直接的影响：

- 下游客户端和上游服务器不会同一天全部升级；
- Switch 必须在同一个入口兼容新旧两代协议；
- 协议版本、能力、缓存和授权上下文不能再靠一段模糊的长会话处理；
- 路线图正在继续推进事件/订阅、HTTP transport 统一、Agent 身份、工具目录缓存和渐进发现。

路线图只是当前方向，不要写成已经落地的保证。

### 3. 这一版实际改了什么

按读者最容易感知的顺序写：

1. **旧客户端不用一起升级。** PR #3 已合并：同一个 `/mcp` 端点兼容 2026-07-28 与旧版客户端，上游也自动协商。
2. **一次调用不再反复重连。** PR #4 引入长生命周期上游 runtime、single-flight 初始化、catalog TTL 与 idle shutdown；不会为了调用一个 stdio 工具连续拉起多个子进程。
3. **工具经过网关不再被“压扁”。** 保留原始 input/output JSON Schema、annotations、icons、execution metadata、`_meta`、结构化和非文本结果。
4. **组件不会因为相同 `ui://` URI 串台。** Switch 为上游 MCP Apps 资源加入 server namespace，并桥接标准字段与 ChatGPT 兼容字段。
5. **OAuth 和容器边界更严格。** resource/audience 绑定、PKCE、refresh replay 吊销、Host/Origin allowlist、rootless/read-only 容器都已进入 PR #4。
6. **App Lab 把“加载失败”拆成能检查的问题。** 它检查 resource link、MIME、bridge、CSP、URI namespace 和 output schema；预览需要人手动打开，不调用真实工具。
7. **WebMCP 让 AI 与人共享控制台。** PR #6 注册五个顶层 Site tools，只读动作可直接执行，页面动作只改变当前视图，配置动作只生成待审草稿。

### 4. MCP、MCP Apps、WebMCP 的区别

| 名称 | 解决的问题 | 在 MCP Switch 中的位置 |
|---|---|---|
| MCP | AI 客户端连接本地或远程服务器；页面不开也能调用 | `/mcp` 数据面 |
| MCP Apps | MCP Server 把表单、图表、播放器等 UI 返回到聊天中的 iframe | 上游 UI metadata、resource relay、App Lab |
| `window.openai` | ChatGPT 提供的可选宿主增强 | 只做 feature detection，不作为通用基础 |
| WebMCP / Site tools | 当前网页把已有操作注册给 AI，与人共享页面和登录态 | `/console` 控制面 |

OpenAI 当前文档明确要求新组件先按开放 MCP Apps 标准实现：用 `_meta.ui.resourceUri` 关联 UI，用 `ui/*` JSON-RPC bridge 通信；`window.openai` 只补标准没有覆盖的 ChatGPT 能力。WebMCP 则必须在顶层页面用 JavaScript 注册；ChatGPT 目前不会发现 iframe 内注册的工具，也不支持声明式表单工具。

## Music MCP：文章里应该怎样写

可以写成一次仍在进行的排障，而不是宣布已经彻底修复 ChatGPT：

> Music MCP 在别的环境能发现工具，播放器到了 ChatGPT 却可能直接不显示。最麻烦的是「组件加载不了」并不是一个错误，它可能发生在工具与资源没关联、MIME 不对、CSP 阻止脚本、`ui/*` bridge 没初始化、返回结构不完整，或者组件把 ChatGPT 的私有宿主变量当成了通用标准。

PR #4 已经完成的证据：Switch 连接 `music-mcp` 0.2 的真实 HTTP 服务后，发现 3 个工具和播放器资源，并在 App Lab 中把两个 UI 工具判断为 standards-first，诊断通过。

仍需实机确认：

- 在最新版 ChatGPT 桌面应用内真正渲染播放器；
- 播放、暂停、尺寸变化与后续消息是否工作；
- ChatGPT、其他 MCP Apps 宿主和不支持 UI 的客户端分别怎样降级。

不要把 App Lab 通过写成「ChatGPT 播放器已经 100% 修好」。

## 截图清单

1. **文章题图后的结构图**：`docs/blog/assets/mcp-switch-architecture.svg`。图注：「客户端只连接一个入口；MCP 是数据面，WebMCP 是共享页面的控制面。」
2. **评审站总览**：显示 Sakura 控制台、四个 KPI 和 WebMCP 状态条。图注：「这不是新的聊天客户端，它仍然是 Switch 的管理控制台。」
3. **Music MCP App Lab**：展开组件诊断和播放器预览。图注：「先判断问题发生在 resource、MIME、bridge 还是宿主增强，而不是盲改 CSS。」
4. **ChatGPT 地址栏中的 Available site tools**：应看到 5 个工具。图注：「工具属于当前页面，离开页面后自动失效。」
5. **AI 生成接入草稿**：名称和 URL 已填，Token/OAuth 仍为空，保存按钮等待人工点击。图注：「AI 可以准备，人决定是否真的连接。」
6. **PR #4 / #6 的 Actions**：两张 PR 截图或合成一张。图注：「协议网关与 WebMCP 控制面分开审查，旧 VPS 没被测试覆盖。」

私有评审站：<https://mcp-switch-webmcp-review.asashiki-5352.chatgpt.site>

## 三分钟演示顺序

1. 打开评审站总览，用一句话说明「一个 `/mcp` 入口，两层协作」。
2. 在 ChatGPT Site tools 中让 AI 执行 `mcp_switch_overview`。
3. 说：「检查 Music MCP 的组件兼容性，并把诊断页面打开给我看。」页面应切到 App Lab。
4. 展示 warning：开放 MCP Apps bridge 是基础，ChatGPT CSS/`window.openai` 只能渐进增强。
5. 说：「把 `https://example.com/mcp` 作为 Example MCP 准备好。」展示待审草稿。
6. 指出 Token、保存、连接和授权都没有被 AI 执行，手动丢弃草稿。

当前 OpenAI 文档要求在 ChatGPT 桌面应用的内置浏览器中测试，使用 GPT-5.6 Sol 或 Terra；Luna 当前禁用 Site tools。移动端或普通浏览器可以查看页面，但不应拿来证明 WebMCP 工具已被 ChatGPT 发现。

## 部署怎么讲才准确

| 方式 | 能展示什么 | 不能冒充什么 |
|---|---|---|
| OpenAI Sites 私有评审站 | 控制台外观、App Lab 交互、五个 WebMCP 工具、截图流程 | 不是完整 Node/SQLite/stdio 网关 |
| 本地 Docker | 完整功能、stdio、真实数据库与回归测试 | ChatGPT 内置浏览器通常不能直接访问回环地址 |
| 本地 + named Cloudflare Tunnel | 不动 VPS 的真实远程 canary，适合 ChatGPT 实机测试 | 电脑关机后不会继续提供服务 |
| VPS Docker | 长期运行、固定域名、完整网关能力 | 升级前仍需独立端口/域名和数据库副本验证 |
| Workers/Vercel Functions | 经过 remote-only、无状态和存储适配后可承载部分能力 | 不能原样运行常驻 Node、原生 SQLite 或任意 stdio 子进程 |

## 可以写与不能写

可以写：

- PR #3 已合并；PR #4 与 #6 仍为 Draft，`main` 和正在使用的 VPS 没被直接修改。
- PR #4 有 32 个 gateway 测试；PR #6 叠加后共 42 个测试。
- PR #6 当前 GitHub Actions CI 已通过。
- App Lab 的预览不调用真实上游工具。
- WebMCP 工具不会接收 Token、Secret、Header、env 或 stdio command。

暂时不能写：

- 「支持所有 MCP capability 透明代理」。prompts/templates/completion 及反向能力还没有全部完成。
- 「所有客户端 UI 完全一致」。不同宿主仍有能力和样式差异。
- 「Music MCP 已在 ChatGPT 全流程播放成功」。需要桌面内置浏览器实机证据。
- 「可以无服务器免费托管完整 MCP Switch」。目前评审站与完整网关不是同一个运行形态。
- 「MCP 已经没人使用」。这只是作者对热度的感受，不是有数据支持的行业结论。

## 最后只需要补的个人细节

文章发布前，作者自己补四小段就会明显不像 AI 稿：

- 你最初为什么写这个项目，当时手上具体有哪几个 MCP；
- 在不同客户端重复配置时，哪一次最烦；
- VPS 旧版实际用了多久、平时怎样用；
- Music 播放器第一次在 ChatGPT 消失时，你看到的具体画面或报错。

不用给文章强行加意义。这四个具体经历比一整段「生态价值」更有用。

## 官方来源

- [MCP 2026-07-28 Specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Roadmap（2026-08-22 更新）](https://modelcontextprotocol.io/development/roadmap)
- [OpenAI：Site tools / WebMCP](https://learn.chatgpt.com/docs/webmcp)
- [OpenAI：Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [WebMCP Community Group Draft](https://webmachinelearning.github.io/webmcp/)
- [MCP Apps Specification](https://modelcontextprotocol.io/extensions/apps/overview)

## 项目证据

- [PR #3：MCP 2026 协议协商，已合并](https://github.com/asashiki/mcp-switch/pull/3)
- [PR #4：协议保真网关，Draft](https://github.com/asashiki/mcp-switch/pull/4)
- [PR #6：WebMCP 控制面，Draft](https://github.com/asashiki/mcp-switch/pull/6)
- [music-mcp PR #1](https://github.com/asashiki/music-mcp/pull/1)
