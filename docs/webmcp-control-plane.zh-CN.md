# WebMCP Control Plane：让人和智能体一起管理 MCP

MCP Switch 原本解决的是「AI 客户端怎样连接许多 MCP」；WebMCP 解决的是另一个问题：
当人已经打开 Switch 控制台时，智能体怎样理解当前页面、读取状态，并把下一步操作准确地
落回人正在看的界面。

这两层不会互相替代：

- `/mcp` 仍是数据面，供 ChatGPT、Claude 等客户端在没有打开控制台时调用聚合工具；
- `/console` 新增 WebMCP 控制面，让支持 Site tools 的智能体与用户操作同一页面、同一登录态；
- App Lab 仍是 UI 诊断面，专门检查 MCP Apps 组件在不同宿主中的元数据和加载问题。

## 已实现的五个站点工具

| 工具 | 用途 | 数据/页面影响 |
|---|---|---|
| `mcp_switch_overview` | 汇总网关、上游、工具、Agent 与当前控制台上下文 | 只读 |
| `list_upstream_mcp_servers` | 按 all / online / attention 列出脱敏后的上游状态 | 只读 |
| `inspect_upstream_mcp_server` | 按 ID 或名称检查一个上游及其工具目录 | 只读，最多返回 100 个工具 |
| `open_mcp_app_lab` | 定位到页面中的上游并运行 MCP Apps 诊断 | 只改变当前页面视图，不调用真实工具 |
| `prepare_remote_mcp_server` | 把 HTTP(S) 地址填进接入表单 | 只生成待审草稿，不保存、不连接、不授权 |

工具元数据使用稳定英文，避免跟随控制台语言变化后让智能体重复学习；人类界面继续支持中文、
英文和日文。

## 为什么不提供「直接添加/删除服务器」

WebMCP 与页面共享登录态，这正是它好用的原因，也是必须收紧边界的原因。当前版本采用三层
权限设计：

1. 状态读取可以直接执行；
2. 定位服务器、打开 App Lab 只改变当前页面；
3. 配置操作只能生成醒目的待审草稿，最后一次保存必须由用户点击。

`prepare_remote_mcp_server` 不接受 Token、Secret、自定义 Header 或环境变量。它还会拒绝
带用户名/密码的 URL 和非 HTTP(S) scheme。智能体返回的草稿会清空表单里可能残留的敏感字段，
避免把上一份配置误配给新上游。

服务器 URL、工具标题、描述以及 App 诊断内容都来自不可信上游。相关只读工具声明了
`untrustedContentHint`，列表结果也不会返回 endpoint、Header 名称、环境变量名和底层错误文本。

## 浏览器生命周期

- 仅在控制台登录成功后注册工具；登录页没有管理工具。
- 使用顶层页面的 `document.modelContext.registerTool()`，不依赖 ChatGPT 当前不支持的 iframe
  或声明式表单 API。
- 每次注册都绑定 `AbortSignal`；React 页面卸载、登出或重新挂载时会自动注销工具，避免旧会话
  的工具残留。
- 不支持 WebMCP 的浏览器不会显示状态条，也不会改变原有控制台行为。
- API 请求接收执行时的 `AbortSignal`，用户或浏览器取消工具调用时会同步取消 fetch。

## 人机协作流程

### 排查音乐组件为什么在 ChatGPT 不显示

1. 在 ChatGPT Work 或 Codex 的内置浏览器打开并登录 Switch 控制台。
2. 询问：「检查 Music MCP 的组件兼容性，并把诊断页面打开给我看。」
3. 智能体调用 `open_mcp_app_lab`；页面定位到对应服务器并展开 App Lab。
4. 人和智能体一起查看 bridge、MIME、resource URI、CSP、output schema 等检查项。

这个动作不会播放音乐，也不会调用任何上游工具。

### 接入一个新的远程 MCP

1. 询问：「帮我把 `https://example.com/mcp` 作为 Example MCP 准备好。」
2. 智能体调用 `prepare_remote_mcp_server`，控制台跳到接入表单并高亮草稿。
3. 用户核对地址，在页面里自行填写 Token/OAuth 信息。
4. 用户手动点击「添加并发现」。

这样既减少了复制粘贴和找表单的步骤，又保留了配置外部连接前的最后人工确认。

## 本地检查

```bash
pnpm install
cp .env.example .env
pnpm dev
```

打开 `http://127.0.0.1:5173/console/`。普通 Chrome 可以检查控制台功能与 UI，但 Site tools
需要当前支持 WebMCP 的 ChatGPT 内置浏览器和受支持模型。如果内置浏览器无法访问本机回环地址，
使用仓库的 named Cloudflare Tunnel canary，把同一个本地服务临时暴露到固定 HTTPS 域名；不需要
改动正在运行的 VPS 版本。

自动验证：

```bash
pnpm test:webmcp
pnpm --filter @mcp-switch/console-web typecheck
pnpm --filter @mcp-switch/console-web build
```

测试覆盖工具清单、注册/注销生命周期、汇总计算、脱敏、名称解析、App Lab 页面联动、草稿边界
以及恶意 URL 拒绝。

## 当前有意保留的限制

- 不直接增加、删除、授权或重新发现服务器；这些动作仍由人执行。
- 不通过 WebMCP 调用任意上游工具；那是 `/mcp` 数据面的职责。
- 不把 stdio command 暴露成自动生成草稿，因为它最终会在网关宿主机执行进程。
- 不注册动态的「每个上游工具一个 WebMCP 工具」，避免工具爆炸、权限混淆和重复协议代理。

后续可以增加「生成权限变更提案」和「把诊断结果保存为报告」，仍应保持 proposal → review →
commit 的双阶段模型。

## 依据

- [OpenAI Site tools / WebMCP 文档](https://learn.chatgpt.com/docs/webmcp)
- [WebMCP Community Group Draft](https://webmachinelearning.github.io/webmcp/)

