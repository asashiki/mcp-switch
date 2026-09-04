# MCP 已经没人聊了，我还是把自己的 MCP 网关重做了一遍

最近 MCP 的热度几乎掉光了。

前一阵子到处都在宣布支持 MCP，现在再提它，多少有点像路边一条没人管的协议。我也不打算硬说它是什么未来标准。我的 VPS 上一直跑着旧版 MCP Switch，平时能用；只是 MCP Server 一多，那些一开始看起来不重要的麻烦全出来了。

本机的服务是 stdio，线上的服务是 HTTP。ChatGPT 要配一遍，Claude 里又配一遍。这里用 OAuth，那里粘一段 Token。某个工具只会搜索，另一个工具真的会改数据，但客户端里看起来可能只是两个相邻的按钮。再碰上一个带播放器的 MCP，各家聊天界面对 UI 的支持还不完全一样。

MCP Switch 最初只是想把这些服务器合成一个 URL。客户端只连接 Switch，Switch 再去找真正的上游。做到后来，它已经不像一个简单的转发器了，更像夹在客户端和一堆 MCP Server 中间的网关。

## 这次为什么要重做

2026-07-28 的 MCP 更新很大。新版基础协议改成了无会话、自描述的请求，每次请求自己带协议和能力信息。看起来更像普通 HTTP 了，但工具、资源、提示词这些仍然是 MCP 的语义，并没有变成一套 REST API。

网关会比普通 MCP Server 更早撞上兼容问题。下游可能已经是新版 ChatGPT，上游却还是几个月没更新的 stdio 工具。让所有东西同一天升级不现实。

现在的 Switch 会在同一个 `/mcp` 端点同时处理 2026 与旧版客户端；连接上游时也会自动协商。部署时我也不准备覆盖 VPS 上的旧版，新版先用另一个端口、域名和数据库跑在旁边。

顺便还修掉了一个很蠢、也很隐蔽的 bug：环境变量 `MCP_OAUTH_ALLOW_LEGACY_RESOURCE_OMISSION` 被解析了两次。测试里传普通对象没问题，真实启动读取 `process.env` 时反而会失败。难怪之前配置怎么都不成功。现在真实构建启动也进了回归测试。

## 一次工具调用，不该启动两个进程

旧实现每次调用上游工具前都会重新连接，先 `listTools` 一次，关掉，再建第二条连接真正调用。HTTP 会多一次往返，stdio 上游甚至可能为了一个工具启动两个子进程。

这一版把连接变成了长生命周期 runtime：同一个上游只做一次初始化，并发请求用 single-flight 合并，工具目录有 TTL，空闲后再关闭。调用失败也不会随便重试写工具，免得「网络抖了一下」变成「同一条数据写了两次」。

以前工具经过 Switch 还会被手工转换成 Zod。简单字段没事，碰到 `$ref`、`oneOf`、`pattern`、范围、默认值就可能丢。现在 input/output schema、annotations、icons、`_meta`、结构化结果和非文本结果尽量原样穿过网关。

这些改动没有新按钮，截图也不漂亮，但它们决定了 Switch 到底是一个网关，还是一个会悄悄改变上游含义的转发器。

## 播放器为什么偏偏在 ChatGPT 里消失

我最想排查的是 Music MCP。它的工具能发现，播放器到了 ChatGPT 却可能加载不出来。

这件事麻烦在于，聊天里的「一块 UI」其实牵涉好几层：工具要用 `_meta.ui.resourceUri` 指到 HTML resource，resource 的 MIME 要正确，iframe 的 CSP 不能挡掉自己，组件要完成 `ui/*` bridge 初始化，工具结果还得给模型和 UI 都看得懂。

OpenAI 现在也把路线说清楚了：新的 UI 先按开放的 MCP Apps 标准做；`window.openai` 是 ChatGPT 的可选增强，不该反过来成为组件能不能运行的前提。

所以我给 Switch 加了一个 App Lab。它不调用真实音乐工具，只读取并检查组件的 metadata、resource、MIME、bridge、CSP、URI namespace 和 output schema。多个上游都叫 `ui://widget/index.html` 时，Switch 还会给 URI 加服务器命名空间，免得 A 的工具最后打开了 B 的页面。

目前真实的 Switch → music-mcp 0.2 HTTP 链路已经能发现 3 个工具和播放器资源，App Lab 的 standards-first 检查也通过了。它还不等于「ChatGPT 里已经完整播放成功」。最后这一步要在最新版 ChatGPT 桌面应用里实测，我准备把成功或失败的画面直接放进文章，不用一句“理论兼容”糊过去。

## WebMCP 放在哪里

MCP、MCP Apps、WebMCP 的名字很像，做的事不同。

MCP 是一直在线的数据面。页面关掉以后，ChatGPT 仍然可以通过 `/mcp` 调工具。

MCP Apps 是 MCP Server 返回到聊天里的组件，比如播放器、图表或表单。

WebMCP 是网页自己的工具。人打开 Switch 控制台以后，AI 可以和人共享这个页面、这个登录态，以及页面上当前选中的服务器。

我没有把三十多个上游工具再注册一遍。控制台只加了五个 WebMCP 工具：读网关总览、列上游、查一个服务器、打开 App Lab、准备远程 MCP 草稿。

前三个只读。打开 App Lab 只改变当前页面。准备接入也只会填写名称、HTTP(S) URL 和说明，不接受 Token、Secret、Header、env 或 stdio command。保存、连接、OAuth 授权和删除仍然要我自己点击。

这套限制不是为了让演示显得安全。WebMCP 和页面共享登录态，如果 AI 一句话就能添加一个会在服务器上执行命令的 stdio MCP，那才是真的麻烦。

## 怎么试

最后我还是准备在原来的 VPS 上并行跑新版。完整网关需要常驻 Node、SQLite 和可选的 stdio 子进程，这些本来就是一台普通服务器擅长的事。

旧版继续占原来的端口和域名。新版使用独立的 Compose project、`4578`、新子域名和新数据卷。先跑健康检查和只读协议检查，再让 ChatGPT 只连接新版。失败了就停掉新版容器，旧版不用动。

## 现在是什么状态

自动化现在有 42 个测试：9 个覆盖 WebMCP 的注册、脱敏、页面联动和草稿边界，另外 33 个覆盖网关、OAuth、存储、远程检查与 App Lab。CI 还会跑类型检查、生产构建和 Docker Compose 配置检查。

还有东西没做完：prompts、resource templates、completion 以及 sampling、elicitation、tasks 这些双向能力没有全部代理；OpenTelemetry 和更完整的兼容矩阵也在后面。Music 播放器还欠一次真正的 ChatGPT 桌面端播放录像。

MCP 以后还能不能重新热起来，我不知道。MCP Switch 已经超过了我最初那句「把几个 Server 塞进同一个 URL」。它开始能处理那些用久以后才会遇到的问题。

## 参考

- [MCP 2026-07-28 Specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Roadmap](https://modelcontextprotocol.io/development/roadmap)
- [OpenAI Site tools / WebMCP](https://learn.chatgpt.com/docs/webmcp)
- [OpenAI MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)
- [mcp-switch 源码](https://github.com/asashiki/mcp-switch)
- [VPS 部署交接单](../VPS-DEPLOY.zh-CN.md)
