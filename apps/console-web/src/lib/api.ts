// =============================================================================
// API client · 樱羽控制台
// 所有请求统一注入 Bearer，401 → 抛错由路由层捕获并跳登录
// =============================================================================

import type {
  Skill, Agent, AgentVisibility, AuditEntry,
  RemoteServer, SkillGroup, StatsRange, HealthOverview,
  LoginRequest, LoginResponse, MeResponse,
} from "@/types/api";
import { tStatic } from "@/i18n/locales";

// ---- 配置 ------------------------------------------------------------------
// 生产部署：把前端构建产物放在 mcp-gateway 同源下，BASE 留空走相对路径
// 本地开发：默认走 vite proxy → /api/* → http://127.0.0.1:4577
const BASE = import.meta.env.VITE_API_BASE ?? "";

const TOKEN_KEY = "mcp-switch.console.token";
const USER_KEY  = "mcp-switch.console.user";

export const TokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export const UserStore = {
  get: () => localStorage.getItem(USER_KEY),
  set: (u: string) => localStorage.setItem(USER_KEY, u),
};

// ---- HTTP ------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = { auth: true },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth !== false) {
    const tk = TokenStore.get();
    if (tk) headers["Authorization"] = `Bearer ${tk}`;
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, tStatic("api.networkError"), e);
  }

  if (res.status === 401) {
    TokenStore.clear();
    throw new ApiError(401, tStatic("api.sessionExpired"));
  }

  let payload: unknown = null;
  const txt = await res.text();
  if (txt) {
    try { payload = JSON.parse(txt); } catch { payload = txt; }
  }

  if (!res.ok) {
    const msg = (payload && typeof payload === "object" && "error" in (payload as any))
      ? (payload as any).error
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, String(msg), payload);
  }
  return payload as T;
}

// ---- 鉴权 ------------------------------------------------------------------

export const Auth = {
  login: (req: LoginRequest) =>
    request<LoginResponse>("POST", "/api/console/login", req, { auth: false }),
  me: () => request<MeResponse>("GET", "/api/console/me"),
  logout: () => request<{ ok: true }>("POST", "/api/console/logout"),
};

// ---- 技能 ------------------------------------------------------------------

export const Skills = {
  list: () => request<{ skills: Skill[] }>("GET", "/api/console/skills"),
  setEnabled: (id: string, enabled: boolean) =>
    request<{ skillId: string; enabled: boolean }>(
      "POST", `/api/console/skills/${encodeURIComponent(id)}/enabled`, { enabled },
    ),
  setAllowWrite: (id: string, allow: boolean) =>
    request<{ skillId: string; allowWrite: boolean }>(
      "POST", `/api/console/skills/${encodeURIComponent(id)}/allow-write`, { allow },
    ),
  reorder: (skillIds: string[]) =>
    request<{ ok: true; count: number }>("POST", "/api/console/skills/reorder", { skillIds }),
};

// ---- Agents ----------------------------------------------------------------

export const Agents = {
  list: () => request<{ agents: Agent[] }>("GET", "/api/console/agents"),
  create: (agentId: string, displayName?: string) =>
    request<{ agentId: string; secret: string | null }>(
      "POST", "/api/console/agents", { agentId, displayName },
    ),
  regen: (id: string) =>
    request<{ agentId: string; secret: string }>(
      "POST", `/api/console/agents/${encodeURIComponent(id)}/regen`,
    ),
  setEnabled: (id: string, enabled: boolean) =>
    request<{ agentId: string; enabled: boolean }>(
      "POST", `/api/console/agents/${encodeURIComponent(id)}/enabled`, { enabled },
    ),
  remove: (id: string) =>
    request<{ ok: true; deleted: string }>("DELETE", `/api/console/agents/${encodeURIComponent(id)}`),
  getVisibility: (id: string) =>
    request<AgentVisibility>("GET", `/api/console/agents/${encodeURIComponent(id)}/visibility`),
  setVisibility: (id: string, skillIds: string[]) =>
    request<{ agentId: string; restricted: boolean; allowlist: string[] }>(
      "POST", `/api/console/agents/${encodeURIComponent(id)}/visibility`, { skillIds },
    ),
};

// ---- 审计 ------------------------------------------------------------------

export const Audit = {
  list: (limit = 150) =>
    request<{ entries: AuditEntry[] }>("GET", `/api/console/audit?limit=${limit}`),
};

// ---- 远程 MCP --------------------------------------------------------------

export const Remote = {
  list: () => request<{ servers: RemoteServer[] }>("GET", "/api/console/remote"),
  // 对齐 claude.ai 表单：name+url 必填；clientId/clientSecret = OAuth 预注册客户端；
  // bearerToken = 静态 token 服务器。id 留空由后端从 name 生成。
  add: (s: {
    name: string; url?: string;
    transport?: "http" | "stdio"; command?: string; args?: string[]; env?: Record<string, string>;
    clientId?: string; clientSecret?: string; bearerToken?: string; headers?: Record<string, string>;
  }) =>
    request<{ ok: true; id: string; discovered: number; needsAuth?: boolean }>("POST", "/api/console/remote", s),
  // 发起 OAuth 授权：返回浏览器跳转 URL（或已持有有效 token）
  oauthStart: (id: string) =>
    request<{ status: "redirect" | "authorized"; authorizeUrl?: string }>(
      "POST", `/api/console/remote/${encodeURIComponent(id)}/oauth/start`,
    ),
  remove: (id: string) =>
    request<{ ok: true; deleted: string }>(
      "DELETE", `/api/console/remote/${encodeURIComponent(id)}`,
    ),
  rediscover: () => request<{ ok: true; seeded: number }>("POST", "/api/console/remote/rediscover"),
};

// ---- 场景分组（后端 2026-06-10 上线，原 localStorage 兜底已移除） -----------

export const SkillGroups = {
  list: () => request<{ groups: SkillGroup[] }>("GET", "/api/console/skill-groups"),
  save: (groups: SkillGroup[]) =>
    request<{ ok: true }>("PUT", "/api/console/skill-groups", { groups }),
};

// ---- 统计 -------------------------------------------------------------------

export const Stats = {
  range: (range: "1h" | "24h" | "7d" | "30d" = "24h") =>
    request<StatsRange>("GET", `/api/console/stats?range=${range}`),
};

// ---- 系统健康 ----------------------------------------------------------------

export const Health = {
  overview: () => request<HealthOverview>("GET", "/api/console/health"),
};
