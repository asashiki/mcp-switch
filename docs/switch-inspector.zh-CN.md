# Switch Inspector：先发现可定位的问题

Inspector 延续 Switch 现有的 MCP Apps diagnostics，不新增一套控制台。到上游服务器配置中的开发者诊断入口检查组件，新增结果沿用现有 checks 展示。

这一版新增 HTML 字面量分析，针对音乐、图片和内嵌组件常见的问题：

| 检查码 | 能发现什么 | 下一步 |
|---|---|---|
| media-autoplay | audio/video 声明 autoplay | 提供点击播放，捕获 play() 拒绝 |
| asset-csp-origin-missing | HTML 素材地址在 CSP 对应列表中没有精确 origin | 音频/图片/脚本检查 resourceDomains；iframe 检查 frameDomains；fetch/XHR 另看 connectDomains |
| asset-insecure-http | 素材使用明文 HTTP | 改为 HTTPS，再验证加载 |
| viewport-fixed-width | viewport 固定宽度大于 480px | 在窄对话框和移动端检查裁切 |
| asset-url-unresolved | 相对地址或协议相对地址 | 检查真实宿主的资源基地址 |
| theme-hooks-not-detected | 未识别到常见主题变量或主题通知标记 | 实测浅色、深色和背景融合 |
| media-runtime-check | 存在音视频元素 | 检查点击、错误、响应类型、范围请求、过期地址与重复通知 |

这是**静态启发式检查**：不执行上游 HTML、不发起素材网络请求、不调用上游业务工具。警告提示你检查对应配置，不能证明宿主已经阻止请求；宿主默认策略、通配符、外部脚本、动态赋值等仍需运行时验证。不会解析 JavaScript 生成的全部 URL、CSS url()、srcset，也不是完整浏览器 HTML 解析器。报告字段保持 `validationScope: static`、`runtimeVerified: false`。

检查消息只显示素材 origin，不显示路径、查询参数或 fragment。忽略注释和 script/style 原始文本中的伪标签，同类提示去重；每个组件最多显示 16 条 HTML 提示，超出会明确提示截断。远程上游原有描述和错误消息仍需按其自身敏感度处理。

## 实际验证表

在准备支持的每一个宿主中分别完成，不预填“通过”：

| 场景 | 验证内容 | 当前证据 |
|---|---|---|
| ChatGPT / Claude / 其他宿主 | 能加载 UI 并完成交互初始化 | 未实测 |
| 首次播放 | 点击后音频确实播放；失败有可读提示 | 未实测 |
| 重复 tool-result | 播放位置不重置、不重建播放器 | 未实测 |
| 浅色 / 深色 | 文字对比、透明背景、宿主主题切换 | 未实测 |
| 移动端 | 窄屏不裁切，按钮可以点到 | 未实测 |
| 临时素材 URL 过期 | 明确提示失效并允许重新获取 | 未实测 |
| 不支持 Apps 的客户端 | 普通文字和结构化结果仍然可用 | 未实测 |

已有 `pnpm check:remote -- --url https://YOUR_GATEWAY` 可做网关协议、OAuth 元数据和组件资源的只读连通性检查；它不等同于上表中的宿主实测，也不会点击播放器。

规则依据：[MCP Apps 官方说明](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html)。源码在 `apps/mcp-gateway/src/registry/app-html-diagnostics.ts`；接入点为现有 `diagnoseMcpApps`，因此对现有页面和 API 同时生效。
