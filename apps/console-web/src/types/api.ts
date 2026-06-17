// =============================================================================
// 与 console-api.md 对齐的数据类型
// Shared API types between the console SPA and the gateway console API.
// =============================================================================

// 功能分类（后端 skillMeta 自动赋予；使用用途的分类是用户自编的 SkillGroup）
export type SkillCategory =
  | "sense"    // 实时感知
  | "history"  // 历史回溯
  | "action"   // 动作输出
  | "search"   // 对外检索
  | "finance"  // 资产
  | "personal" // 个人档案
  | "remote"   // 远程工具（source=remote-mcp 时）
  | "meta";    // 系统

export type SkillSource = "local" | "remote-mcp";

export interface Skill {
  skillId: string;
  title: string;
  category: SkillCategory;
  source: SkillSource;
  enabled: boolean;
  description: string | null;
  allowWrite: boolean;
  readOnly: boolean | null;   // 仅 remote 工具有：true=只读, false=写工具
  serverId: string | null;    // 仅 remote 工具有：所属远程 MCP 服务器 id
  serverName: string | null;  // 仅 remote 工具有：服务器显示名（虚拟分组用）
  sortOrder: number;
  updatedAt: string;
}

export interface Agent {
  agentId: string;
  displayName: string;
  role: string;
  enabled: boolean;
  createdAt: string;
  lastAuthorizedAt: string | null;
  lastUsedAt: string | null;
}

export interface AgentVisibility {
  agentId: string;
  restricted: boolean;          // 是否启用白名单
  allowlist: string[];          // 白名单 skillId
  enabledSkills: string[];      // 当前 agent 实际可见的 skill 列表（后端计算）
}

export interface AuditEntry {
  created_at: string;
  agent_id: string | null;
  client_id: string | null;
  tool_name: string | null;
  action: string;
  success: 0 | 1;
  latency_ms: number | null;
  detail: string | null;
}

export interface RemoteTool {
  name: string;
  title: string | null;
  description: string | null;
  readOnlyHint: boolean;
  inputSchema: unknown;
}

export interface RemoteServer {
  id: string;
  name: string;
  url: string;
  description: string;
  status: string;
  /** http=远程 URL 中转 / stdio=本机拉起子进程托管。缺省视为 http。 */
  transport?: "http" | "stdio";
  /** stdio 托管的命令/参数（控制台「查看配置」用）。 */
  command?: string;
  args?: string[];
  /** 已配置的 env / header 键名（仅键名，值不外泄）。 */
  envKeys?: string[];
  headerKeys?: string[];
  /** none=开放直连 / bearer=静态token / bearer-env=env token / oauth=授权码流程 */
  authMode: "none" | "bearer" | "bearer-env" | "oauth";
  /** 服务器要求 OAuth 授权（显示「去授权」按钮） */
  needsAuth?: boolean;
  /** OAuth 服务器已持有 token */
  oauthAuthorized?: boolean;
  lastError: string | null;
  toolCount: number;
  tools: RemoteTool[];
}

// =============================================================================
// 控制台前端特有的扩展类型（需要后端补端点 — 详见 BACKEND_TODOS.md）
// =============================================================================

export interface SkillGroup {
  id: string;
  name: string;
  order: number;
  skillIds: string[];        // 该组下技能的 skillId 列表（按 order 排序）
}

export interface StatsRange {
  range: "1h" | "24h" | "7d" | "30d";
  totalCalls: number;
  errorCalls: number;
  unauthorizedCalls: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** 折线点：时间戳秒 + 计数 */
  timeline: Array<{ t: number; n: number }>;
  /** 工具排行：按调用数倒序 */
  topTools: Array<{ skillId: string; title: string; count: number }>;
  /** Agent 占比 */
  byAgent: Array<{ agentId: string; displayName: string; count: number; pct: number }>;
  /** 与上一周期对比 */
  deltaVsPrev: {
    totalCalls: number;        // 百分比变化 like +0.12 / -0.05
    errorCalls: number;
    p95LatencyMs: number;      // ms 绝对变化
  };
}

export interface HealthOverview {
  gateway: { ok: boolean; uptime: string; note?: string };
  /** 各连接器状态：每个已接入的上游 MCP 服务器一条 */
  connectors: Array<{
    id: string;             // remote-mcp-<serverId>
    name: string;
    status: "ok" | "warn" | "err" | "disabled";
    note?: string;
  }>;
}

// =============================================================================
// 鉴权
// =============================================================================

export interface LoginRequest { username: string; password: string }
export interface LoginResponse { token: string; username: string; expiresInSeconds: number }
export interface MeResponse { username: string }
