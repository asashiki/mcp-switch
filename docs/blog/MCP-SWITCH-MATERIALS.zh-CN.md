# MCP Switch 博客素材

这份文件先收材料，不假装已经是最终文章。里面的判断都对应当前项目代码或
`docs/research/MCP-2026-07-28.md` 里的官方资料。

## 文章一：MCP 又变回普通 HTTP 了吗？

我第一次看 2026-07-28 的改动时，确实有一种「怎么绕了一圈又回来了」的
感觉。`initialize`、`initialized`、`Mcp-Session-Id` 不再是新 HTTP 协议的
中心。请求自己带 `_meta`，告诉服务器协议版本、客户端是谁、支持什么能力。
服务器收到一条请求，靠这条请求本身就能处理。

这很像普通 HTTP，但也没真的退回 REST。线上跑的还是 JSON-RPC，工具、资源、
提示词、订阅这些 MCP 语义都在。变化的是状态放在哪里。旧版先建立一段连接
上下文，新版把足够的信息放回每次请求。

对 MCP Switch 这种网关，影响比普通工具服务器大。它同时面对两边：下游可能
是已经升级的 ChatGPT 或 SDK v2 客户端，上游还可能是一个很久没更新的 stdio
服务器。直接只支持新版，会让现有配置突然失效；永远停在旧版，又吃不到缓存、
订阅和新的交互模型。

这次我采用的办法很朴素。`/mcp` 用 SDK 2.0 的统一 handler，新请求走
2026-07-28，旧请求走 stateless fallback。MCP Switch 连接上游时先自动探测，
确认对方支持新版就用新版，不支持就执行旧握手。升级不再要求所有服务器同一天
切换。

文章里可以继续展开的几个具体点：

- 为什么 `server/discover` 是协商，不是另一套业务 API；
- `subscriptions/listen` 如何替代「为了推送而维持整段会话」的思路；
- `input_required` 为什么会让网关不能随便把结果压成一段文本；
- `ttlMs` / `cacheScope` 对大型工具目录的意义；
- HTTP 基础设施终于更容易按 `Mcp-Method`、`Mcp-Name` 做日志和路由。

建议标题：

- 《MCP 又变回 HTTP 了吗？我把网关升级到 2026-07-28 后的理解》
- 《没有 initialize 的 MCP：2026-07-28 到底改了什么》

## 文章二：我为什么做 MCP Switch

我做 MCP Switch 的起点不是「再写一个 MCP Server」。真正麻烦的是 MCP 多起来
以后：本机有 stdio，线上有 HTTP；有些工具只读，有些会改数据；不同 agent
不该看到同一套工具；还有 OAuth、刷新 token、审计记录和 UI resource。

如果每个客户端分别配置这一堆服务器，配置会复制，权限也会散开。MCP Switch
把它们收进一个入口。上游仍然保持原样，客户端只连 `/mcp`。控制台负责服务器
配置、工具开关、分组和 agent 可见范围，调用时再把请求转发给真正的上游。

目前项目里最值得写的不是界面截图，而是几条已经落到代码里的取舍：

- MCP Switch 自己不塞内置工具，列表来自上游发现；
- read 工具可以默认启用，write 工具需要明确开启；
- OAuth token 对应到 agent，`tools/list` 在每个请求里按 agent 过滤；
- MCP Apps 的 tool `_meta` 和 resource 会继续向下游转发；
- 新旧 MCP 协议在同一个入口共存，上游也逐个协商，不做一次性迁移。

有些事情还没做完，文章里可以坦白写。上游连接池、完整的 2026 metadata、Apps
URI 冲突处理、RFC 8707 resource 绑定，都已经列进升级清单。这样比写成一个
「万能 MCP 平台」更接近项目现在的样子。

建议标题：

- 《我不想在每个 AI 客户端里再配一遍 MCP》
- 《MCP Switch：给散落的 MCP Server 加一个总入口》

## 可配的图

一张结构图就够：左边是 ChatGPT、Claude、其他 agent，中间只有 MCP Switch，
右边分成本地 stdio 和远程 HTTP。图上再标三条横切能力：OAuth、可见性、审计。
不要画成十几层的「平台架构图」，这个项目的卖点正是入口变少了。

