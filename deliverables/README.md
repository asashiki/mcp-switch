# Companion MCP 交付入口

- [下载运行包 ZIP](https://github.com/asashiki/mcp-switch/actions/runs/35131018026/artifacts/10461107567)（需登录 GitHub，保留至 2026-12-15）
- [成功的构建及测试记录](https://github.com/asashiki/mcp-switch/actions/runs/35131018026)
- [源码和部署说明](../apps/companion-mcp/README.md)
- [工作记录](../apps/companion-mcp/WORKLOG.md)
- [验证记录](../apps/companion-mcp/VALIDATION.md)
- [界面截图](../apps/companion-mcp/docs/screenshots/)

源码提交：79b24531980349340d68e481e2ed1eb2271ad3c1。CI 构建使用 GitHub PR 的合并测试提交，包内 VERSION.json 记录具体来源。

先解压 ZIP，再解压其中的 companion-mcp-runtime.tar.gz。包内已包含依赖，Node.js 24+ 可直接运行：复制 .env.example 为 .env，设置自己的 COMPANION_TOKEN，然后 npm start。打开 http://127.0.0.1:4588/admin 配置角色。

ZIP 同时包含 SHA256SUMS 和实际打包/验证日志。独立运行验证覆盖鉴权、MCP 工具、场景更新、提示词预览、组件资源及重启恢复。

源码、截图和构建脚本随 Git 保存。二进制提交因上传中断未完成；当前不要寻找仓库内的 tar.gz。Actions 产物到期后可从源码重新构建：在根目录安装依赖后执行 node apps/companion-mcp/scripts/package.mjs，再执行 node apps/companion-mcp/scripts/verify-package.mjs。

真实 NAI 出图、VPS 部署和 ChatGPT / Claude 的实际连接尚未验证。运行包不含真实密钥或已确认角色插画。
