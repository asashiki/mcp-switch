# Agent Savepoint：让下一位 AI 接得上

一个可独立接入 MCP Switch 的 stdio MCP 服务，和网关共用现有 Node 24 / TypeScript / MCP SDK 依赖。它保存任务状态、文件本体和不可变历史版本；换对话或换模型后，可以从指定版本继续。

这是可运行的初版。它不会自动监听聊天或读取 Agent 沙盒，也不承诺在宿主未调用 checkpoint 时保存工作。数据库必须放在持久磁盘；如果把数据库也放进会被清除的沙盒，仍然会丢失。当前没有自动 Git push、对象存储备份、跨用户权限、另一模型调度或 Tasks 扩展实现。

## 启动与接入

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-gateway/dist/cli/savepoint.js --db /persistent/savepoint/vault.sqlite
```

开发时可用 `pnpm --filter @mcp-switch/mcp-gateway savepoint --db /persistent/savepoint/vault.sqlite`。默认运行 MCP stdio，不会开启 HTTP 端口。不要使用 pnpm 包装命令作为 stdio 上游，以免日志混入协议 stdout。

将下列配置粘贴进 Switch 的上游导入框，替换成服务器上的绝对路径：

```json
{
  "mcpServers": {
    "savepoint": {
      "command": "node",
      "args": [
        "/opt/mcp-switch/apps/mcp-gateway/dist/cli/savepoint.js",
        "--db", "/persistent/savepoint/vault.sqlite"
      ]
    }
  }
}
```

导入后按 Switch 的既有流程启用所需工具，并为写入工具授权。也可以直接连接支持本地 stdio 的客户端。Docker 部署应把数据库目录挂载到持久卷，代码路径用容器内的实际路径。此功能未默认开启，不会改变现有上游或音乐组件。

**隔离单位是整个数据库。** 所有能访问该服务的客户端都能读取其中所有任务。不同用户或不同保密范围使用独立的服务实例、数据库和 Switch 授权；taskId 不是权限凭据。新增数据库文件以仅当前用户可读写的权限创建，已有目录和文件权限由部署者管理。

## 一次完整使用

1. 调用 `create_task`：`{"requestId":"music-fix-start","title":"修复音乐播放","goal":"保留现有 UI，修复播放并检查宿主行为"}`。返回 `taskId` 和 `revision: 0`。
2. 到达一个里程碑时调用 `checkpoint`（替换 TASK_ID）：

```json
{
  "taskId": "TASK_ID",
  "requestId": "music-fix-step-1",
  "expectedRevision": 0,
  "summary": "已保存播放器修改，等待宿主验证。",
  "nextSteps": ["在 ChatGPT 中点击播放", "确认重复通知不重建播放器"],
  "decisions": ["保留原 UI"],
  "constraints": ["浅色和深色主题均需可读"],
  "status": "active",
  "artifacts": [
    {"path":"notes/playback.md","encoding":"utf8","content":"待验证：用户点击后调用 play()，捕获拒绝并显示原因。"}
  ]
}
```

3. 只有收到成功回执才说“已保存”。回执包含版本、路径、字节数和 SHA-256。超时后使用**相同 requestId 和相同参数**重试，返回原回执；不要立刻创建新的保存请求。
4. 新对话用 `list_tasks` 找任务，再用 `resume_task` 读取最新状态，用 `read_artifact` 读取明确版本的文件。文件以 base64 返回，客户端解码后恢复到自己的工作区。
5. `prepare_handoff` 接收 taskId、target、assignment，可选 revision，生成包含目标、决策、限制、待办、文件清单的交接包。结果标记 `delivery: not_sent`；它不会登录 Claude、发送消息或启动另一个 Agent。接收方必须连接同一 vault 才能按清单取文件；跨 vault 使用下面的自包含导出。

`summary / nextSteps / decisions / constraints / status` 是完整状态替换；每次 checkpoint 都应传入仍有效的状态。文件清单是增量更新：未传入的路径保留，同名文件换成新内容，`removePaths` 从当前清单移除文件，旧版本仍可读。保存公开可说明的决策摘要，不收集模型私有推理或原始聊天记录。仅保存明确需要的文件，不扫描工作区、不自动上传凭据。

## 冲突、失败与导出

- 两个 Agent 从同一版本开始，先保存的成功，后保存的收到 `revision_conflict`。后者应重新读取、协调内容，用新的 requestId 保存；不能盲目修改版本号覆盖。
- 相同 requestId 携带不同内容收到 `idempotency_conflict`。
- SQLite 使用 WAL + FULL synchronous，状态、文件内容和重试回执在同一事务提交。磁盘失败或超出容量时不返回成功。
- 文件读取重新验证哈希；损坏会返回 `integrity_error`，不会把损坏文件伪装成正常成果。
- 单文件最多 512 KiB，每次上传共 2 MiB，最多 32 个文件；单任务当前清单最多 256 个路径。二进制使用标准带 padding 的 base64。整个 vault 的去重文件内容上限 256 MiB；这不是数据库总大小上限，历史状态和回执仍会增长。此版不自动删除历史，请按实际规模规划容量。

导出某个任务的状态和**全部当前文件字节**，不需要模型逐个下载：

```bash
node apps/mcp-gateway/dist/cli/savepoint.js \
  --db /persistent/savepoint/vault.sqlite \
  --export TASK_ID --revision 1 --output /backup/task-revision-1.json
```

省略 revision 导出最新版本；省略 output 写入 stdout。output 必须是新文件，拒绝覆盖。JSON 格式 `agent-savepoint-export/v1` 包含 snapshot 和 base64 files，可供其他程序验证哈希并恢复文件；此版没有自动导入命令。只在目标工作区人工确认后写入文件，不能把交接内容当系统指令执行。

整库备份请使用 SQLite 的在线备份工具，或停止全部 Savepoint 进程后复制数据库；不要在写入期间只复制主文件而遗漏 WAL。导出文件包含实际内容，应放在你授权的备份位置。

## 和其他灵感的关系

- **Agent Handoff** 已实现交接包和版本固定，模型调度以后再接。
- **Switch Inspector** 沿用现有 `app-diagnostics.ts` 和 `pnpm check:remote`。静态诊断与宿主实际验证分开，不把静态通过当作音频播放成功。
- **MCP Tasks** 是异步长任务机制，不能代替存档服务。Savepoint 当前通过普通工具提供能力，不声称实现 Tasks 扩展。[MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)。

验证：`pnpm typecheck`、`pnpm test`、`pnpm build`；新增测试涵盖真实 stdio 进程重启、MCP 调用、二进制保真、事务回滚、冲突、重试、历史版本、损坏检测及无覆盖导出。
