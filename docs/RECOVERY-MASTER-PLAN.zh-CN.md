# MCP Switch 完整恢复与进化总账

更新时间：2026-08-30

这份文件是本轮工作的永久检查点。它恢复最初需求、长时间调研中已经形成的判断、
2026 协议升级后的新增要求，以及中断后缩水交付中遗漏的内容。后续实现以本文件为准，
不再依赖临时工作区或聊天上下文。

## 1. 原始目标

MCP Switch 不是单纯的 MCP Server，而是一个统一连接本地 stdio 与远程 HTTP MCP、
集中处理 OAuth、权限、审计、工具分组和 MCP Apps UI 的自托管网关。

本次升级需要同时完成：

- 调研并适配当前 MCP 稳定协议与 TypeScript SDK；
- 保持用户正在 VPS 使用的旧客户端、旧上游和现有数据库兼容；
- 改善网关延迟、稳定性、协议保真、安全性与可观察性；
- 让 ChatGPT、Claude 及其他兼容宿主尽可能正确显示 MCP Apps 组件；
- 排查现有音乐播放器在 ChatGPT 中无法加载的问题；
- 提供本地测试和免费或低成本远程预览方案；
- 为之后介绍 MCP Switch 的中文博客保存可信材料；
- 将可复用安全基线逐步应用到 sticker-mcp、music-mcp、device-timeline-mcp 与展示站。

## 2. 不可违反的交付约束

- 不直接修改或推送 `main`；所有工作进入 `agent/*` 功能分支。
- 不自动合并；以 Draft PR 交付给用户审核。
- 用户正在 VPS 运行的旧版不能被本轮测试覆盖或破坏。
- 数据库迁移必须向后兼容，并提供回滚说明。
- 每个可验证纵切面完成后立即提交并推送，不能把长时间成果只留在临时目录。
- 文档必须区分“已经实现”“经过验证”“仅规划”，禁止把待办包装成成果。

## 3. 当前已存在的基线（PR #3）

- TypeScript SDK 2.0 分包迁移；
- 下游 `/mcp` 同端点兼容 2026-07-28 与旧版协议；
- 上游客户端启用自动版本协商；
- OAuth `AuthInfo` 注入与 `tools:read` / `tools:write` 基础过滤；
- 新旧客户端真实 HTTP 集成测试；
- 初步研究笔记和博客素材。

这些只是本轮起点，不代表完整升级已经完成。

## 4. 从早期调研恢复的核心缺口

### P0：网关正确性与可靠性

- 上游仍采用 connect-per-call；stdio 工具调用会频繁拉起子进程，HTTP 也无法保持状态。
- 需要长生命周期 `UpstreamRuntime`：单飞连接、复用、发现缓存、TTL、退避重连、
  超时、失效与 idle shutdown。
- 当前通过 JSON Schema → Zod 手工重建输入结构，会丢失 `$ref`、`oneOf`、
  `pattern`、范围、默认值等约束；应尽量使用 SDK 的原始 Schema 注册能力或保真桥接。
- 需要完整保留工具字段：`inputSchema`、`outputSchema`、annotations、icons、title、
  execution metadata、`_meta` 和结构化结果。
- 工具名必须做稳定、合法、长度受限且可逆查询的映射，避免 server/tool 名冲突。

### P0：认证与运行安全

- OAuth 授权码、access token 与 refresh token 必须绑定 canonical MCP resource，落实
  RFC 8707 resource/audience 校验和正确 scope challenge。
- 核对 Client ID Metadata Document、PKCE、issuer/mix-up 防护、redirect URI 精确匹配，
  有边界地保留 DCR 兼容。
- 校验 Host/Origin；外网部署提供明确 allowlist。
- Docker 与 stdio 子进程应最小权限运行：非 root、精简环境、只读文件系统、资源限制、
  命令或镜像策略，并避免读取网关数据库及 OAuth 凭据。
- secret 不应明文暴露在 API、日志或 URL query 中。

### P1：MCP Apps 与聊天 UI

- 以开放 MCP Apps 为基础：工具 `_meta.ui.resourceUri`、UI resource 和 `ui/*` bridge
  必须端到端保留；`window.openai` 仅作为 ChatGPT 渐进增强。
- 多个上游可能发布相同的 `ui://...` URI；必须按 server namespace 重写 resource URI，
  并同步重写 tool `_meta` 与资源返回内容，不能继续 first-wins。
- 组件必须在 iframe/CSP/resource MIME/HTML 编码/bridge 初始化方面通过检查。
- 每个带 UI 的工具仍必须在不渲染组件的客户端正常工作。
- 建立 App Lab：同时显示 raw tool metadata、resource HTML、bridge 事件、CSP/MIME 诊断，
  并提供 ChatGPT-compatible 与 standards-only 两种宿主模拟。
- 优先用 music-mcp 复现并修复 ChatGPT 中播放器加载失败。

### P1：协议能力与动态目录

- 保存原始 capability descriptor，而不是只把上游压缩为 tools + 少量 resources。
- 正确处理分页、cache hints、list-change notifications 与订阅。
- 逐步代理 prompts、resource templates、completion、logging；sampling、elicitation、
  tasks 等反向或多轮能力必须在完成请求 ID、取消和状态映射后再开放。
- 大量 MCP 聚合时支持 profile/view、按 agent 可见性与延迟发现，避免工具爆炸。

### P1：可观察性与运维

- 增加不记录参数、结果和凭据的结构化指标：连接、发现、调用、重试、超时、错误类别、
  结果大小和 trace ID。
- 控制台展示服务器健康、最近发现、协议版本、能力、缓存命中、调用延迟与错误摘要。
- 提供 conformance、smoke、真实 HTTP/stdio 上游和兼容矩阵测试。

### P2：相关项目与展示

- sticker-mcp：Header-only 管理 token、SSRF 防护、下载大小/重定向校验、组件元数据检查。
- music-mcp：修复 ChatGPT 播放器、共享 OAuth/transport 安全基线、提供无 UI 降级结果。
- device-timeline-mcp：远程入口默认认证，个人活动数据最小暴露，可作为 Switch 内部上游。
- show.asashiki.com：展示实际兼容矩阵、协议版本、认证模式、Inspector/App Lab 状态、
  客户端安装片段和真实组件截图。
- 评估抽取共享 `@asashiki/mcp-kit`，但只在重复实现已经稳定后执行，避免过早抽象。

## 5. 目标架构

MCP Switch 的目标定位：

> 一个兼容新旧 MCP、能够保真代理能力、统一认证与策略、隔离不可信上游，
> 并让 MCP Apps 在不同聊天宿主中可诊断运行的自托管 MCP Gateway。

内部拆分为四个边界：

1. `DownstreamGateway`：协议协商、认证、agent/profile 策略和对外 capability。
2. `UpstreamRuntimeManager`：每服务器/授权上下文的连接、发现缓存、重连与生命周期。
3. `CapabilityProjection`：名称映射、Schema/metadata 保真、UI URI namespace 与能力裁剪。
4. `Diagnostics`：审计、指标、兼容性检查和 App Lab。

## 6. 实现与远端检查点

1. **Recovery checkpoint**：本总账、代码现状审计与测试矩阵。
2. **Gateway fidelity**：连接运行时、完整工具元数据、稳定命名、分页与缓存。
3. **Auth and isolation**：OAuth resource、Host/Origin、secret 与 stdio/Docker 基线。
4. **Apps compatibility**：URI namespace、resource relay、music 复现、App Lab。
5. **Operations**：指标、健康诊断、部署模板和升级/回滚流程。
6. **Project family**：相关 MCP 仓库独立分支与 Draft PR。
7. **Release material**：测试报告、兼容矩阵、部署指南和中文博客草稿。

## 7. 验收标准

- 旧版客户端与旧上游不需要同时升级；
- 连续调用同一 HTTP/stdio 上游不会重复建立不必要的连接或子进程；
- 复杂 JSON Schema 和完整 tool/result metadata 经过 Switch 后不被压扁；
- 相同 UI resource URI 的两个上游不会串台；
- music-mcp 在标准 MCP Apps 测试宿主中加载，并为 ChatGPT 提供兼容增强或明确诊断；
- 本地 Docker 可以一条命令启动，远程预览不依赖修改现有 VPS；
- 所有测试、构建、迁移和回滚命令可复现；
- 每项完成状态均能由代码、测试或部署证据证明。
