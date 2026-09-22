# MCP 客户端兼容性检查（2026-09-19）

本轮保留现有组件布局与样式，只处理协议、生命周期、媒体与普通客户端回退。没有重新设计播放器，也没有增加 App Lab 操作步骤。

## 范围和结果

| 项目 | 本轮结果 |
| --- | --- |
| voice-send-mcp | 重复宿主通知不再重新创建音频；新结果和销毁清理旧播放；捕获播放拒绝；媒体按扩展名提供 MIME，支持跨域与 Range；普通客户端可读文本及音频链接 |
| sticker-mcp | 稳定组件生命周期；日志改 stderr，避免污染 stdio；移除上传凭据日志；修正上传工具输出 schema；普通客户端返回有大小上限的标准 MCP image；修复 clean install 锁文件 |
| reel-rando-mcp | 重复通知不重启动画，新抽签可正常更新；取消旧计时器；普通客户端直接获得抽签结果 |
| Companion / NAI（本仓库 PR #9） | 标准结果优先于过时 legacy 通知；重复数据不重置图片；切换场景和销毁会取消轮询，旧响应不能覆盖新场景；支持文本 JSON 工具结果；拒绝会生成错误媒体地址的部署配置 |
| device-timeline-mcp | 检查 stdio 入口及工具输出：返回文本，入口日志使用 stderr；没有发现同类 HTML 生命周期问题，本轮不改 |
| microsoft-todo-mcp-server | 检查工具、传输和认证提示：返回标准数据，登录提示使用 stderr；认证页不是聊天组件，本轮不改 |
| 个人聚合 MCP | 检查入口及天气、时间日志、X 搜索：使用文本/结构化输出，无聊天 HTML 组件；本轮不改 |
| music-mcp | 本轮只参考已合入的组件回归方式；没有再次替换 UI；真实音源播放仍必须在部署端与实际宿主验收 |

语音、表情与抽签同时移除了硬编码部署域名，保留现有样式。标准 MCP Apps 与 legacy globals 不再同时反复覆盖画面，晚到的 legacy bridge 仍可提供数据。

## 验证证据和限制

- Voice：8 项测试，包括实际构建组件的重复通知/新结果/高度/销毁、播放拒绝，以及真实 HTTP WAV MIME 和 206 Range。
- Sticker：5 项测试，包括组件生命周期和不声明 UI 能力的真实 MCP SDK 客户端读取图片/上传结果。
- Reel：5 项测试，包括组件生命周期和不声明 UI 能力的 SDK 客户端直接读取抽签结果。
- Companion：13 项测试。原有 HTTP → Switch → SDK 新旧协议链路保留；新增 5 项覆盖场景组件、轮询中止与媒体地址配置。
- 组件运行测试使用受控 DOM/宿主事件。Companion 的 SDK 回调被模拟；它们不等于真实浏览器布局、媒体解码或 ChatGPT/Claude/Grok 验收。
- 本轮没有连接 VPS，没有请求付费 TTS/NAI，没有读取个人业务数据。文本服务为代码检查，不声称完成其线上集成测试。

## 宿主边界

MCP Apps 是可选扩展。能调用 MCP 工具不代表能渲染 HTML 组件。支持 Apps 的宿主使用组件；普通客户端仍有文字、链接或标准图片内容，避免将 UI 作为唯一结果。图片如何展示也由宿主决定。

不能从 xAI Remote MCP API 文档推断 grok.com 对话界面支持 MCP Apps。本轮没有把三个产品的实机状态填写为“通过”。

参考：[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)、[xAI Remote MCP](https://docs.x.ai/developers/tools/remote-mcp)。

## 部署后验收

分别测试直连和经 Switch 调用：重复同一结果、换一个新结果、深浅色切换、实际播放/图片下载，再关闭组件。检查浏览器实际请求的 URL、重定向、Content-Type、CSP 与响应状态；“拿到地址”和“组件显示”均不能当作播放/图片加载成功。

给 VPS AI 的交接：更新这次修复分支并重建对应 MCP，保留配置和素材，核对公开媒体地址后测试真实播放与图片加载；NAI 先验证已有素材，不自动触发付费生成。
