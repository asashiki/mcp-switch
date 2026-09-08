# MCP Apps App Lab：跨宿主组件诊断

**这里的通过只指静态检查通过，不代表 ChatGPT 里能播放或正常交互。** API 和 WebMCP 摘要明确返回 `validationScope: "static"`、`runtimeVerified: false`。桥接检测只是检查 HTML 中的协议标记，没有执行握手或验证媒体。2026-09 的 Music 闪烁故障说明，字段正确仍可能反复销毁播放器。

MCP Apps 组件失效时，表面现象经常只是“ChatGPT 里一片空白”，实际故障可能出在不同层：工具没有链接资源、`ui://` URI 对不上、资源 MIME 仍是旧值、只实现了 `window.openai`、CSP 漏掉媒体域，或者声明了一个根本不可达的专用 widget origin。

开发诊断（原 App Lab）入口已移到「查看配置」里面，日常接入不需要打开。它不会把“Claude 能显示”当成“协议一定正确”，而是分别检查开放 MCP Apps 字段和 ChatGPT 兼容别名。

## 检查内容

- 工具 `ui.resourceUri` 与 `openai/outputTemplate` 是否存在、是否一致；
- 对应资源是否真的出现在 `resources/list`；
- MIME 是否为 `text/html;profile=mcp-app`，以及 Switch 是否进行了旧格式归一化；
- HTML 是否包含标准 `ui/initialize` / `ui/*` bridge，或只依赖 `window.openai`；
- resource `ui.csp` / `openai/widgetCSP` 的 domain 是否为安全 HTTPS origin；
- `ui.domain` / `openai/widgetDomain` 是否为精确 HTTPS origin；
- UI tool 是否提供 `outputSchema`，从而让宿主验证 `structuredContent`；
- 是否存在没有任何工具引用的孤立组件资源；
- Switch 为资源生成的 server-scoped `ui://mcp-switch/<server>/...` URI。

相同的上游 `ui://widget/index.html` 出现在多个 MCP 时不会再串台：工具链接、资源列表与读取结果会一起重写到各自 namespace。

## 隔离预览

App Lab 默认只显示诊断，不自动执行上游 HTML。点击「加载 sandbox 预览」后才读取组件，并满足以下边界：

- iframe 只有 `allow-scripts`，没有 `allow-same-origin`、表单、弹窗、下载和顶层导航权限；
- 控制台根据资源声明的 CSP 注入一条额外限制策略；多条 CSP 只会取交集，上游不能用自己的 meta 放宽它；
- 组件 HTML 最大 512 KiB；
- App Lab 模拟 `ui/initialize`、tool result 和 size change，不调用真实工具；
- 预览不再自动注入 schema 生成的假数据；需要粘贴真实工具返回的 `structuredContent` 后发送；
- 为观察旧组件，sandbox 会提供只含 `toolOutput` 的最小 `window.openai` 兼容对象。

「发送样例」会向现有 iframe 发送结果和兼容 globals，不重载页面；「重放宿主通知」在约 2.5 秒内重复发送 25 次相同数据，用来检查闪烁、音频重建、进度归零和按钮焦点丢失。它不调用真实上游工具，也不会自动给出运行时通过结论。不再用 `example.com` 假媒体地址制造无意义的播放失败。

这个预览用于检查布局、主题基础和 bridge 数据流，不等价于最终宿主认证。ChatGPT、Claude 可能对专用域审核、文件上传、模态框、host context 和宿主扩展能力有额外差异，因此 canary 上仍需做一次真实客户端测试。

## 历史记录：与 music-mcp 0.2 的静态交叉验证

本轮在同一临时网络中启动 `music-mcp` 0.2，并让 Switch 通过真实 Streamable HTTP 连接它。结果：

- 上游状态 `online`；
- 发现 `search_song`、`play_song`、`play_playlist`；
- 发现 `ui://music-mcp/player-v7.html`，MIME 为 `text/html;profile=mcp-app`；
- 识别两个 UI tools，两个 HTML 都判定为 `mcp-apps` bridge；
- 诊断状态为 `pass`，无 warning/error；
- App preview 成功读取约 15 KiB 的完整内联 HTML。

这条验证没有连接或修改生产 VPS，只使用本地临时进程。

## Music 闪烁修复与验收

上游 0.2 播放器在每个 `openai:set_globals` 通知和重复 tool result 后清空 root、销毁并重建音频；入场淡入动画被反复触发。针对旧 bundle 的模拟宿主测试发送 25 轮重复/主题通知，创建 76 个音频对象。修复按歌曲数据去重，分开处理主题，保留音频和播放位置，并让高度报告等待初始化且去重。

修复在 [music-mcp PR #1](https://github.com/asashiki/music-mcp/pull/1)，资源版本为 `player-v8.html`，部署步骤见 [上游修复说明](https://github.com/asashiki/music-mcp/blob/agent/chatgpt-mcp-apps-compat/docs/CHATGPT-PLAYER-STABILITY.zh-CN.md)。先更新 Music canary，再让 Switch 重新发现上游，最后刷新 ChatGPT 插件并重新调用。只更新 Switch 不会替换上游 HTML。

本轮通过了实际 bundle 的模拟 DOM/媒体生命周期测试；浏览器策略阻止了本地页面和文件测试，因此没有 ChatGPT 实机播放、截图或录像证据。线上是否还有 CSP、媒体可达性或部署版本问题，需要用同一首歌对比直连和经 Switch 转发。
