# MCP Apps App Lab：跨宿主组件诊断

MCP Apps 组件失效时，表面现象经常只是“ChatGPT 里一片空白”，实际故障可能出在不同层：工具没有链接资源、`ui://` URI 对不上、资源 MIME 仍是旧值、只实现了 `window.openai`、CSP 漏掉媒体域，或者声明了一个根本不可达的专用 widget origin。

MCP Switch 控制台的「接入」页现在为每个在线上游提供 App Lab。它不会把“Claude 能显示”当成“协议一定正确”，而是分别检查开放 MCP Apps 字段和 ChatGPT 兼容别名。

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
- `structuredContent` 样例由 `outputSchema` 生成，可以在预览旁编辑后重新发送；
- 为观察旧组件，sandbox 会提供只含 `toolOutput` 的最小 `window.openai` 兼容对象。

这个预览用于检查布局、主题基础和 bridge 数据流，不等价于最终宿主认证。ChatGPT、Claude 可能对专用域审核、文件上传、模态框、host context 和宿主扩展能力有额外差异，因此 canary 上仍需做一次真实客户端测试。

## 与 music-mcp 0.2 的交叉验证

本轮在同一临时网络中启动 `music-mcp` 0.2，并让 Switch 通过真实 Streamable HTTP 连接它。结果：

- 上游状态 `online`；
- 发现 `search_song`、`play_song`、`play_playlist`；
- 发现 `ui://music-mcp/player-v7.html`，MIME 为 `text/html;profile=mcp-app`；
- 识别两个 UI tools，两个 HTML 都判定为 `mcp-apps` bridge；
- 诊断状态为 `pass`，无 warning/error；
- App preview 成功读取约 15 KiB 的完整内联 HTML。

这条验证没有连接或修改生产 VPS，只使用本地临时进程。
