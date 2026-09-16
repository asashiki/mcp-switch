# 验证记录

2026-09-16，Node 24。这里区分本地协议验证、浏览器验证与真实宿主验证。

| 项目 | 结果 |
| --- | --- |
| Companion 类型检查与构建 | 通过 |
| 全仓库类型检查与原项目构建 | 通过 |
| 原项目回归 | 42 / 42 通过 |
| Companion 回归 | 7 / 7 通过，包含多组断言 |
| SDK 新版直连 | 实际启动 HTTP 服务，协商 2026-07-28，工具调用与 UI 资源读取通过 |
| SDK 新版经 Switch | 实际启动 Companion 和 Switch，转发、工具命名、场景数据、UI MIME 通过 |
| SDK 旧版经 Switch | 非 2026-07-28 协议路径调用与 UI 资源读取通过 |
| 场景一致性 | 连续 20 轮、重复事件、版本冲突、跨 owner 拒绝、历史快照、配置隔离与重启恢复通过 |
| 生成队列 | 模拟 provider：串行、重复事件一次生成、限额、迟到结果、中断不自动重试通过 |
| NAI 请求 / 响应 | 按官方结构模拟 JSON + base64 PNG；429 不重试；密钥只在后端请求中 |
| Chromium 浏览器 | 实际页面登录、保存、素材上传与加载、重复渲染保留人物 DOM、无 pageerror |
| 页面布局 | 浅色、深色、390px 窄屏截图检查，无水平溢出；修复深色文字与预览高度 |
| ChatGPT 真实聊天 | **未验证**：当前没有连接新服务的宿主会话 |
| Claude 真实聊天 | **未验证**：当前没有连接新服务的宿主会话 |
| NAI 实际出图与一致性 | **未验证**：没有实际账户 Token，未消耗任何 NAI 额度 |
| Docker 构建 / VPS 部署 | **未验证**：提供部署文件，当前无 Docker daemon 或 VPS 访问 |

旧项目原有测试使用 tsx CLI；这个环境的 CLI IPC pipe 不可用，因此以 `node --import tsx --test` 运行完全相同的测试文件，42 项通过。Companion 的测试命令已直接使用这个无需 IPC 的入口。

## 本地截图

截图展示的是未上传正式立绘的配置状态，没有把虚构素材当作已确认角色。上传功能另用 1px PNG fixture 验证，未把这个 fixture 当角色展示。

- [浅色设置页](docs/screenshots/settings-light.png)
- [深色设置页](docs/screenshots/settings-dark.png)
- [窄屏设置页](docs/screenshots/settings-mobile.png)

复现：先构建，安装 Playwright 和 Chromium，执行 `node scripts/verify-ui.cjs`。脚本支持 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 与 `COMPANION_QA_OUTPUT`。极简 Linux 缺少中文字体时可通过 `COMPANION_QA_FONT` 指定本地 WOFF2，仅用于截图环境，不改变应用交付的字体或页面内容。

## 部署后还要验证

1. 使用正式 HTTPS 域名，设置 NAI Token、正式角色 Prompt 与至少两张确认的立绘。
2. 在 Switch 开启 Companion 工具后，分别用 ChatGPT、Claude 开一个新对话，切换两次表情；记录组件实际出现位置和是否重复显示。
3. 发起一张 CG 请求，期间切换到下一幕；确认 CG 只归入原快照。
4. 翻开旧消息、刷新页面、恢复会话，检查图片链接、授权、浅深主题，以及模型是否自然调用工具。
5. 如果宿主没有显示 Apps，检查 image 内容 / 图片链接退化，而不是声称该宿主完整兼容。

这些是待实测项，不属于本地通过结果。当前 PR 适合部署验证，不应标记成已完成跨平台上线。
