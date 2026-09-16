# Companion MCP 工作记录

本文件保存可复核的方案理由、实现进度、发现的问题、测试结果和下一步入口。代码、截图和运行包保存在 GitHub；临时沙盒清空后，直接从本分支恢复。

## 2026-09-16：第一阶段

- 参考了 asashiki/sticker-mcp 的工具说明与聊天内 MCP Apps 图片呈现。
- 选择独立服务 apps/companion-mcp，由 Switch 负责 OAuth 和工具路由。没有把角色业务塞进网关，也没有改原控制台。
- 人物外貌、画风与服装配置固定；对话只提交当前动作、表情、场景与台词。形象模式不加载人设，角色模式才加载。
- SQLite 保存会话与每轮快照，避免状态依赖某条 MCP 连接；配置修改不改变旧会话。
- 已确认立绘用于即时回应，NovelAI 用于新场景 CG。CG 任务绑定原场景版本，不覆盖后续场景。
- 新版与旧版 SDK 客户端经真实 Switch 转发通过；新增 7 项测试和原项目 42 项测试通过。
- 配置页实测登录、上传、保存、图片加载、稳定 DOM 和三种布局；修复深色文字对比度及预览高度。
- 源码、截图、文档已在两次远端提交中保存：09df4e7 与 aaac7fe。
- PR #9 的 GitHub Actions 第 20 次运行通过：https://github.com/asashiki/mcp-switch/actions/runs/35125855370

## 2026-09-16：恢复与继续交付

用户再次进入后，临时工作目录已经清空。通过 GitHub 确認 aaac7fe 仍存在，随后从 feat/companion-mcp 重新 clone，恢复了全部源码与三张截图；没有从头重写。

### 修复

发现部署文档允许 Switch 使用 Docker 服务名连接，但 Host 白名单只允许 localhost 和公网域名，导致 `Host: companion:4588` 被拒绝。新增 COMPANION_ALLOWED_HOSTS 精确白名单并测试：允许配置的服务名，拒绝伪造后缀域名，且不因此放开 Origin 校验。

### 运行包

增加 scripts/package.mjs，打包完整服务端依赖、组件、示例配置、许可证及构建来源，产生约 560 KB 的独立 tar.gz。无需安装项目依赖，Node 24+ 可直接运行。只复制明确列出的交付文件，不打包 .env、运行数据库、用户素材或凭据。

增加 scripts/verify-package.mjs：将包解压至独立临时目录，移除 NODE_PATH 和 NODE_OPTIONS，在没有 node_modules 的条件下实测启动、认证、组件读取、MCP 调用、NAI Prompt 预览、禁用真实付费生成和重启恢复。已通过。

CI 会重新打包并执行相同验证，上传运行包、校验值与打包/运行日志，保存 90 天。另外将一份验证后的固定版本运行包提交至仓库 deliverables/，避免用户必须依赖临时路径或限时 Actions 产物。

### 仍需真实账户验证

- 没有 NOVELAI_API_TOKEN，未调用真实 NAI，也未消耗额度。
- 没有 VPS 凭据，未部署至用户服务器。
- 新服务未接进实际 ChatGPT / Claude 账户，因此不能宣称宿主效果已通过。
- 这些是外部配置缺口，不是源码或中间产物丢失。可从独立包的 START-HERE.md 和本目录 README.md 继续，无需重新开发。

## 恢复入口

```bash
git clone --branch feat/companion-mcp https://github.com/asashiki/mcp-switch.git
cd mcp-switch
```

先读本文件，再读 VALIDATION.md。源码在 src/，网页在 web/，示例 Prompt 在 examples/，自动测试在 tests/，三张截图在 docs/screenshots/，可下载包在根目录 deliverables/。PR：https://github.com/asashiki/mcp-switch/pull/9。
