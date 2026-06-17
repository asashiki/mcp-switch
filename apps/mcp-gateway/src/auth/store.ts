import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateToken, hashPassword, randomId, sha256hex, TOKEN_PREFIX, verifyPassword } from "./tokens.js";

export interface AgentRow {
  agentId: string;
  displayName: string;
  role: string;
  enabled: boolean;
  createdAt: string;
  lastAuthorizedAt: string | null;
  lastUsedAt: string | null;
}

export interface OAuthClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export interface PendingAuthorization {
  pendingId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AccessTokenContext {
  tokenHash: string;
  clientId: string;
  agentId: string;
  scope: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function resolveAuthDbPath(inputPath: string): string {
  return resolve(process.cwd(), inputPath);
}

export class AuthStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const full = resolveAuthDbPath(dbPath);
    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(full);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_authorized_at TEXT,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_pending (
        pending_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope TEXT NOT NULL,
        state TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        consumed INTEGER NOT NULL DEFAULT 0,
        replaced_by_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        agent_id TEXT,
        client_id TEXT,
        tool_name TEXT,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        latency_ms INTEGER,
        detail TEXT
      );

      CREATE TABLE IF NOT EXISTS console_admins (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS console_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_registry (
        skill_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        enabled INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_visibility (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS console_skill_groups (
        username TEXT PRIMARY KEY,
        groups_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- UI/template resources exposed by remote MCP servers (MCP Apps widgets),
      -- relayed to agents so remote tool UIs render through the gateway.
      CREATE TABLE IF NOT EXISTS remote_resources (
        server_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        name TEXT,
        title TEXT,
        description TEXT,
        mime_type TEXT,
        meta_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server_id, uri)
      );

      -- Registry of upstream MCP servers added via the console (or seeded from
      -- REMOTE_MCP_SERVERS_JSON). Both HTTP (remote URL) and stdio (locally
      -- hosted) transports are stored here.
      CREATE TABLE IF NOT EXISTS remote_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        description TEXT NOT NULL,
        bearer_token_env TEXT,
        bearer_token TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_visibility_agent ON skill_visibility(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at DESC);
    `);
    // Additive migrations for existing DBs.
    try { this.db.exec(`ALTER TABLE skill_registry ADD COLUMN remote_meta TEXT`); } catch { /* exists */ }
    // Per-tool write opt-in for remote write tools (forwarded as allowWrite).
    try { this.db.exec(`ALTER TABLE skill_registry ADD COLUMN allow_write INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    // read/write classification (1=read-only, 0=write, NULL=unknown), so the
    // console can tag a skill 可读/写入 for local + remote uniformly.
    try { this.db.exec(`ALTER TABLE skill_registry ADD COLUMN read_only INTEGER`); } catch { /* exists */ }

    // remote_servers OAuth client/token state (RFC 8414 discovery + RFC 7591 DCR).
    const remoteOauthColumns = [
      "oauth_client_id TEXT", "oauth_client_secret TEXT", "oauth_client_info_json TEXT",
      "oauth_tokens_json TEXT", "oauth_code_verifier TEXT", "oauth_state TEXT", "oauth_redirect_uri TEXT"
    ];
    for (const col of remoteOauthColumns) {
      try { this.db.exec(`ALTER TABLE remote_servers ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    // stdio (locally hosted) servers: transport=http|stdio; stdio spawns command/args/env.
    const remoteStdioColumns = [
      "transport TEXT NOT NULL DEFAULT 'http'", "command TEXT", "args_json TEXT", "env_json TEXT"
    ];
    for (const col of remoteStdioColumns) {
      try { this.db.exec(`ALTER TABLE remote_servers ADD COLUMN ${col}`); } catch { /* exists */ }
    }
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  /**
   * Create an agent with a freshly generated secret. Returns the plaintext
   * secret ONCE — it is never recoverable afterward (only the hash is stored).
   * Idempotent on agent_id: if it already exists, returns null secret.
   */
  upsertAgent(agentId: string, displayName: string, role = "user"): { agentId: string; secret: string | null } {
    const existing = this.getAgent(agentId);
    if (existing) {
      this.db.prepare(`UPDATE agents SET display_name = ?, role = ? WHERE agent_id = ?`)
        .run(displayName, role, agentId);
      return { agentId, secret: null };
    }
    const secret = generateToken("amcp_sk_");
    this.db.prepare(`
      INSERT INTO agents (agent_id, display_name, secret_hash, role, enabled, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(agentId, displayName, sha256hex(secret), role, nowIso());
    return { agentId, secret };
  }

  /** Regenerate an agent's secret. Returns the new plaintext secret once. */
  regenerateSecret(agentId: string): string | null {
    if (!this.getAgent(agentId)) return null;
    const secret = generateToken("amcp_sk_");
    this.db.prepare(`UPDATE agents SET secret_hash = ? WHERE agent_id = ?`)
      .run(sha256hex(secret), agentId);
    return secret;
  }

  getAgent(agentId: string): AgentRow | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAgent(row) : null;
  }

  listAgents(): AgentRow[] {
    const rows = this.db.prepare(`SELECT * FROM agents ORDER BY agent_id`).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapAgent(r));
  }

  setAgentEnabled(agentId: string, enabled: boolean): boolean {
    const res = this.db.prepare(`UPDATE agents SET enabled = ? WHERE agent_id = ?`)
      .run(enabled ? 1 : 0, agentId);
    if (Number(res.changes) === 0) return false;
    if (!enabled) {
      // Disabling an agent immediately invalidates all its tokens.
      this.db.prepare(`UPDATE oauth_access_tokens SET revoked = 1 WHERE agent_id = ?`).run(agentId);
      this.db.prepare(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE agent_id = ?`).run(agentId);
    }
    return true;
  }

  /** Delete an agent and cascade: revoke tokens, drop its visibility allowlist. */
  deleteAgent(agentId: string): boolean {
    const res = this.db.prepare(`DELETE FROM agents WHERE agent_id = ?`).run(agentId);
    if (Number(res.changes) === 0) return false;
    this.db.prepare(`UPDATE oauth_access_tokens SET revoked = 1 WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM skill_visibility WHERE agent_id = ?`).run(agentId);
    return true;
  }

  /** Verify an agent is enabled and the supplied secret matches. */
  verifyAgentSecret(agentId: string, secret: string): boolean {
    const row = this.db.prepare(`SELECT secret_hash, enabled FROM agents WHERE agent_id = ?`).get(agentId) as
      | { secret_hash: string; enabled: number }
      | undefined;
    if (!row || row.enabled !== 1) return false;
    return sha256hex(secret) === row.secret_hash;
  }

  private mapAgent(r: Record<string, unknown>): AgentRow {
    return {
      agentId: String(r.agent_id),
      displayName: String(r.display_name),
      role: String(r.role),
      enabled: Number(r.enabled) === 1,
      createdAt: String(r.created_at),
      lastAuthorizedAt: r.last_authorized_at ? String(r.last_authorized_at) : null,
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null
    };
  }

  // ── Dynamic client registration ─────────────────────────────────────────

  registerClient(clientName: string, redirectUris: string[]): OAuthClientRow {
    const clientId = randomId(16);
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(clientId, clientName, JSON.stringify(redirectUris), createdAt);
    return { clientId, clientName, redirectUris, createdAt };
  }

  getClient(clientId: string): OAuthClientRow | null {
    const row = this.db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`).get(clientId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      clientId: String(row.client_id),
      clientName: String(row.client_name),
      redirectUris: JSON.parse(String(row.redirect_uris_json)) as string[],
      createdAt: String(row.created_at)
    };
  }

  // ── Pending authorizations ──────────────────────────────────────────────

  createPending(input: Omit<PendingAuthorization, "pendingId" | "createdAt" | "expiresAt"> & { ttlSeconds: number }): PendingAuthorization {
    const pendingId = randomId(18);
    const createdAt = nowIso();
    const expiresAt = plusSeconds(input.ttlSeconds);
    this.db.prepare(`
      INSERT INTO oauth_pending
        (pending_id, client_id, client_name, redirect_uri, code_challenge, code_challenge_method, scope, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pendingId, input.clientId, input.clientName, input.redirectUri,
      input.codeChallenge, input.codeChallengeMethod, input.scope, input.state ?? null,
      createdAt, expiresAt
    );
    return { pendingId, createdAt, expiresAt, ...input };
  }

  getPending(pendingId: string): PendingAuthorization | null {
    const row = this.db.prepare(`SELECT * FROM oauth_pending WHERE pending_id = ?`).get(pendingId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (String(row.expires_at) < nowIso()) {
      this.deletePending(pendingId);
      return null;
    }
    return {
      pendingId: String(row.pending_id),
      clientId: String(row.client_id),
      clientName: String(row.client_name),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      codeChallengeMethod: String(row.code_challenge_method),
      scope: String(row.scope),
      state: row.state ? String(row.state) : null,
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at)
    };
  }

  deletePending(pendingId: string): void {
    this.db.prepare(`DELETE FROM oauth_pending WHERE pending_id = ?`).run(pendingId);
  }

  // ── Authorization codes ─────────────────────────────────────────────────

  issueCode(input: {
    clientId: string;
    agentId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    ttlSeconds: number;
  }): string {
    const code = generateToken(TOKEN_PREFIX.code);
    this.db.prepare(`
      INSERT INTO oauth_codes
        (code_hash, client_id, agent_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, consumed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      sha256hex(code), input.clientId, input.agentId, input.redirectUri,
      input.codeChallenge, input.codeChallengeMethod, input.scope,
      plusSeconds(input.ttlSeconds), nowIso()
    );
    // Mark agent as authorized.
    this.db.prepare(`UPDATE agents SET last_authorized_at = ? WHERE agent_id = ?`).run(nowIso(), input.agentId);
    return code;
  }

  /** Consume a code (single-use). Returns its record if valid + unconsumed + unexpired. */
  consumeCode(code: string): {
    clientId: string;
    agentId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
  } | null {
    const hash = sha256hex(code);
    const row = this.db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(hash) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (Number(row.consumed) === 1 || String(row.expires_at) < nowIso()) {
      // Replay or expired: delete defensively.
      this.db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(hash);
      return null;
    }
    this.db.prepare(`UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ?`).run(hash);
    return {
      clientId: String(row.client_id),
      agentId: String(row.agent_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      codeChallengeMethod: String(row.code_challenge_method),
      scope: String(row.scope)
    };
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  issueTokenPair(input: {
    clientId: string;
    agentId: string;
    scope: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    chainId?: string;
  }): { accessToken: string; refreshToken: string; expiresIn: number; chainId: string } {
    const accessToken = generateToken(TOKEN_PREFIX.access);
    const refreshToken = generateToken(TOKEN_PREFIX.refresh);
    const chainId = input.chainId ?? randomId(16);
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO oauth_access_tokens (token_hash, client_id, agent_id, scope, expires_at, revoked, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(sha256hex(accessToken), input.clientId, input.agentId, input.scope, plusSeconds(input.accessTtlSeconds), createdAt);
    this.db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, agent_id, scope, chain_id, expires_at, revoked, consumed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(sha256hex(refreshToken), input.clientId, input.agentId, input.scope, chainId, plusSeconds(input.refreshTtlSeconds), createdAt);
    return { accessToken, refreshToken, expiresIn: input.accessTtlSeconds, chainId };
  }

  /** Validate a bearer access token. Returns context if valid + agent enabled. */
  validateAccessToken(token: string): AccessTokenContext | null {
    const hash = sha256hex(token);
    const row = this.db.prepare(`SELECT * FROM oauth_access_tokens WHERE token_hash = ?`).get(hash) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (Number(row.revoked) === 1 || String(row.expires_at) < nowIso()) return null;
    const agentId = String(row.agent_id);
    const agent = this.getAgent(agentId);
    if (!agent || !agent.enabled) return null;
    this.db.prepare(`UPDATE oauth_access_tokens SET last_used_at = ? WHERE token_hash = ?`).run(nowIso(), hash);
    this.db.prepare(`UPDATE agents SET last_used_at = ? WHERE agent_id = ?`).run(nowIso(), agentId);
    return { tokenHash: hash, clientId: String(row.client_id), agentId, scope: String(row.scope) };
  }

  /**
   * Rotate a refresh token. On valid single-use, consume it and issue a new
   * pair on the same chain. On replay (already consumed), revoke the whole chain.
   */
  rotateRefreshToken(refreshToken: string, opts: { accessTtlSeconds: number; refreshTtlSeconds: number }):
    | { accessToken: string; refreshToken: string; expiresIn: number; scope: string; agentId: string }
    | { error: "invalid" | "replayed" | "expired" | "agent_disabled" } {
    const hash = sha256hex(refreshToken);
    const row = this.db.prepare(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`).get(hash) as
      | Record<string, unknown>
      | undefined;
    if (!row) return { error: "invalid" };
    if (Number(row.revoked) === 1) return { error: "invalid" };
    if (Number(row.consumed) === 1) {
      // Replay detected — revoke the entire chain.
      const chainId = String(row.chain_id);
      this.revokeChain(chainId);
      return { error: "replayed" };
    }
    if (String(row.expires_at) < nowIso()) return { error: "expired" };
    const agentId = String(row.agent_id);
    const agent = this.getAgent(agentId);
    if (!agent || !agent.enabled) return { error: "agent_disabled" };

    const scope = String(row.scope);
    const clientId = String(row.client_id);
    const chainId = String(row.chain_id);
    const pair = this.issueTokenPair({
      clientId, agentId, scope, chainId,
      accessTtlSeconds: opts.accessTtlSeconds,
      refreshTtlSeconds: opts.refreshTtlSeconds
    });
    this.db.prepare(`UPDATE oauth_refresh_tokens SET consumed = 1, replaced_by_hash = ? WHERE token_hash = ?`)
      .run(sha256hex(pair.refreshToken), hash);
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, expiresIn: pair.expiresIn, scope, agentId };
  }

  revokeChain(chainId: string): void {
    const rows = this.db.prepare(`SELECT agent_id FROM oauth_refresh_tokens WHERE chain_id = ? LIMIT 1`).get(chainId) as
      | { agent_id: string }
      | undefined;
    this.db.prepare(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE chain_id = ?`).run(chainId);
    // Access tokens don't carry chain_id; revoke by agent as a safe superset is too broad,
    // so we rely on their short TTL. Refresh chain is fully revoked here.
    void rows;
  }

  /** Revoke a single token (access or refresh) by its plaintext value. */
  revokeToken(token: string): boolean {
    const hash = sha256hex(token);
    const a = this.db.prepare(`UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?`).run(hash);
    if (Number(a.changes) > 0) return true;
    const r = this.db.prepare(`SELECT chain_id FROM oauth_refresh_tokens WHERE token_hash = ?`).get(hash) as
      | { chain_id: string }
      | undefined;
    if (r) {
      this.revokeChain(r.chain_id);
      return true;
    }
    return false;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  audit(entry: {
    agentId?: string | null;
    clientId?: string | null;
    toolName?: string | null;
    action: string;
    success: boolean;
    latencyMs?: number | null;
    detail?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO audit_log (created_at, agent_id, client_id, tool_name, action, success, latency_ms, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(), entry.agentId ?? null, entry.clientId ?? null, entry.toolName ?? null,
      entry.action, entry.success ? 1 : 0, entry.latencyMs ?? null, entry.detail ?? null
    );
  }

  // ── Console admin accounts + sessions ───────────────────────────────────

  /** Create or reset a console admin (username + password). */
  setConsoleAdmin(username: string, password: string): void {
    const existing = this.db.prepare(`SELECT username FROM console_admins WHERE username = ?`).get(username);
    if (existing) {
      this.db.prepare(`UPDATE console_admins SET password_hash = ? WHERE username = ?`).run(hashPassword(password), username);
    } else {
      this.db.prepare(`INSERT INTO console_admins (username, password_hash, created_at) VALUES (?, ?, ?)`)
        .run(username, hashPassword(password), nowIso());
    }
  }

  listConsoleAdmins(): string[] {
    const rows = this.db.prepare(`SELECT username FROM console_admins ORDER BY username`).all() as { username: string }[];
    return rows.map((r) => r.username);
  }

  /** Verify console credentials; returns true on match. */
  verifyConsoleAdmin(username: string, password: string): boolean {
    const row = this.db.prepare(`SELECT password_hash FROM console_admins WHERE username = ?`).get(username) as
      | { password_hash: string }
      | undefined;
    if (!row) return false;
    const ok = verifyPassword(password, row.password_hash);
    if (ok) this.db.prepare(`UPDATE console_admins SET last_login_at = ? WHERE username = ?`).run(nowIso(), username);
    return ok;
  }

  /** Create a console session, return the plaintext token (set as cookie). */
  createConsoleSession(username: string, ttlSeconds: number): string {
    const token = generateToken("amcp_cs_");
    this.db.prepare(`INSERT INTO console_sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(sha256hex(token), username, nowIso(), plusSeconds(ttlSeconds));
    return token;
  }

  /** Validate a console session token; returns username or null. */
  validateConsoleSession(token: string): string | null {
    const row = this.db.prepare(`SELECT username, expires_at FROM console_sessions WHERE token_hash = ?`).get(sha256hex(token)) as
      | { username: string; expires_at: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at < nowIso()) {
      this.db.prepare(`DELETE FROM console_sessions WHERE token_hash = ?`).run(sha256hex(token));
      return null;
    }
    return row.username;
  }

  deleteConsoleSession(token: string): void {
    this.db.prepare(`DELETE FROM console_sessions WHERE token_hash = ?`).run(sha256hex(token));
  }

  /** Recent audit entries for the console viewer. */
  recentAudit(limit = 100): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`SELECT created_at, agent_id, client_id, tool_name, action, success, latency_ms, detail FROM audit_log ORDER BY id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[];
    return rows;
  }

  /**
   * Aggregate tool-call stats over [cutoff, now) for the console overview.
   * Counts `tool_call` audit rows (per-tool auditing; older `mcp_request`-only
   * rows carry no tool_name and are excluded by design).
   */
  auditStats(windowSeconds: number, bucketSeconds: number, offsetSeconds = 0): {
    totalCalls: number;
    errorCalls: number;
    unauthorizedCalls: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    timeline: Array<{ t: number; n: number }>;
    topTools: Array<{ skillId: string; title: string; count: number }>;
    byAgent: Array<{ agentId: string; count: number }>;
  } {
    const nowMs = Date.now() - offsetSeconds * 1000;
    const cutoff = new Date(nowMs - windowSeconds * 1000).toISOString();
    const upper = new Date(nowMs).toISOString();

    const totals = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
      FROM audit_log WHERE action = 'tool_call' AND created_at >= ? AND created_at < ?
    `).get(cutoff, upper) as { total: number; errors: number | null };

    const unauthorized = this.db.prepare(`
      SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mcp_unauthorized' AND created_at >= ? AND created_at < ?
    `).get(cutoff, upper) as { n: number };

    const latencies = this.db.prepare(`
      SELECT latency_ms FROM audit_log
      WHERE action = 'tool_call' AND created_at >= ? AND created_at < ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms
    `).all(cutoff, upper) as { latency_ms: number }[];
    const pct = (p: number): number => {
      if (latencies.length === 0) return 0;
      const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * p));
      return latencies[idx]?.latency_ms ?? 0;
    };

    // Bucketed timeline; t = bucket start in epoch seconds.
    const buckets = new Map<number, number>();
    const windowStartSec = Math.floor((nowMs - windowSeconds * 1000) / 1000);
    const calls = this.db.prepare(`
      SELECT created_at FROM audit_log WHERE action = 'tool_call' AND created_at >= ? AND created_at < ?
    `).all(cutoff, upper) as { created_at: string }[];
    const lastBucket = Math.max(0, Math.ceil(windowSeconds / bucketSeconds) - 1);
    for (const c of calls) {
      const sec = Math.floor(new Date(c.created_at).getTime() / 1000);
      const idx = Math.min(lastBucket, Math.max(0, Math.floor((sec - windowStartSec) / bucketSeconds)));
      const t = windowStartSec + idx * bucketSeconds;
      buckets.set(t, (buckets.get(t) ?? 0) + 1);
    }
    const timeline: Array<{ t: number; n: number }> = [];
    for (let t = windowStartSec; t < Math.floor(nowMs / 1000); t += bucketSeconds) {
      timeline.push({ t, n: buckets.get(t) ?? 0 });
    }

    const topTools = (this.db.prepare(`
      SELECT a.tool_name AS skillId, COALESCE(s.title, a.tool_name) AS title, COUNT(*) AS count
      FROM audit_log a LEFT JOIN skill_registry s ON s.skill_id = a.tool_name
      WHERE a.action = 'tool_call' AND a.created_at >= ? AND a.created_at < ? AND a.tool_name IS NOT NULL
      GROUP BY a.tool_name ORDER BY count DESC LIMIT 10
    `).all(cutoff, upper) as Array<{ skillId: string; title: string; count: number }>);

    const byAgent = (this.db.prepare(`
      SELECT agent_id AS agentId, COUNT(*) AS count
      FROM audit_log WHERE action = 'tool_call' AND created_at >= ? AND created_at < ? AND agent_id IS NOT NULL
      GROUP BY agent_id ORDER BY count DESC
    `).all(cutoff, upper) as Array<{ agentId: string; count: number }>);

    return {
      totalCalls: Number(totals.total),
      errorCalls: Number(totals.errors ?? 0),
      unauthorizedCalls: Number(unauthorized.n),
      p50LatencyMs: pct(0.5),
      p95LatencyMs: pct(0.95),
      timeline,
      topTools,
      byAgent
    };
  }

  // ── Console skill groups (user-defined scene grouping, display-only) ─────

  getSkillGroups(username: string): Array<{ id: string; name: string; order: number; skillIds: string[] }> {
    const row = this.db.prepare(`SELECT groups_json FROM console_skill_groups WHERE username = ?`).get(username) as
      | { groups_json: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.groups_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  setSkillGroups(username: string, groups: Array<{ id: string; name: string; order: number; skillIds: string[] }>): void {
    this.db.prepare(`
      INSERT INTO console_skill_groups (username, groups_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET groups_json = excluded.groups_json, updated_at = excluded.updated_at
    `).run(username, JSON.stringify(groups), nowIso());
  }

  /**
   * skillId → group name across ALL console users (merged; first claim wins).
   * Used to surface the console grouping in MCP tools/list (title prefix), so
   * claude.ai / ChatGPT / Grok show the same grouping after a refresh.
   */
  getSkillGroupNameMap(): Map<string, string> {
    const rows = this.db.prepare(`SELECT groups_json FROM console_skill_groups`).all() as { groups_json: string }[];
    const map = new Map<string, string>();
    for (const row of rows) {
      try {
        const groups = JSON.parse(row.groups_json) as Array<{ name?: string; skillIds?: string[] }>;
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (typeof g?.name !== "string" || !Array.isArray(g?.skillIds)) continue;
          for (const id of g.skillIds) {
            if (typeof id === "string" && !map.has(id)) map.set(id, g.name);
          }
        }
      } catch { /* skip malformed */ }
    }
    return map;
  }

  // ── Skill registry ──────────────────────────────────────────────────────

  /**
   * Seed a skill if absent. Never overwrites `enabled` on an existing row
   * (so console toggles survive restarts); refreshes title/category/desc.
   */
  seedSkill(input: {
    skillId: string;
    title: string;
    category: string;
    source?: string;
    enabled: boolean;
    description?: string | null;
    sortOrder?: number;
    /** read-only? true=read, false=write, undefined=unknown. */
    readOnly?: boolean;
    remoteMeta?: { serverId: string; serverName?: string; toolName: string; inputSchema: Record<string, unknown>; readOnly?: boolean; toolMeta?: Record<string, unknown> | null } | null;
  }): void {
    const remoteJson = input.remoteMeta ? JSON.stringify(input.remoteMeta) : null;
    const readOnly = input.readOnly === undefined ? null : (input.readOnly ? 1 : 0);
    const existing = this.db.prepare(`SELECT skill_id FROM skill_registry WHERE skill_id = ?`).get(input.skillId);
    if (existing) {
      // Never resets `enabled` or `sort_order` (console toggles + drag order
      // survive restarts); refreshes title/category/desc/remote schema +
      // read/write classification only.
      this.db.prepare(`UPDATE skill_registry SET title = ?, category = ?, source = ?, description = ?, remote_meta = COALESCE(?, remote_meta), read_only = COALESCE(?, read_only), updated_at = ? WHERE skill_id = ?`)
        .run(input.title, input.category, input.source ?? "local", input.description ?? null, remoteJson, readOnly, nowIso(), input.skillId);
      return;
    }
    this.db.prepare(`
      INSERT INTO skill_registry (skill_id, title, category, source, enabled, description, sort_order, remote_meta, read_only, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.skillId, input.title, input.category, input.source ?? "local", input.enabled ? 1 : 0, input.description ?? null, input.sortOrder ?? 0, remoteJson, readOnly, nowIso());
  }

  /** Remote-tool descriptors for the given enabled+visible skill ids. */
  getRemoteDescriptors(ids: Set<string>): Array<{ skillId: string; title: string; description: string | null; serverId: string; toolName: string; inputSchema: Record<string, unknown>; allowWrite: boolean; meta: Record<string, unknown> | null }> {
    if (ids.size === 0) return [];
    const rows = this.db.prepare(`SELECT skill_id, title, description, remote_meta, allow_write FROM skill_registry WHERE source = 'remote-mcp' AND remote_meta IS NOT NULL`).all() as Record<string, unknown>[];
    const out = [];
    for (const r of rows) {
      const id = String(r.skill_id);
      if (!ids.has(id)) continue;
      try {
        const m = JSON.parse(String(r.remote_meta)) as { serverId: string; toolName: string; inputSchema: Record<string, unknown>; toolMeta?: Record<string, unknown> | null };
        // Enabling a remote skill IS the write opt-in now (the per-tool
        // allow_write sub-toggle was removed): any enabled tool is allowed to
        // run, write or not. getRemoteDescriptors is only ever called with the
        // enabled+visible id set, so allowWrite is unconditionally true here.
        out.push({ skillId: id, title: String(r.title), description: r.description ? String(r.description) : null, serverId: m.serverId, toolName: m.toolName, inputSchema: m.inputSchema ?? {}, allowWrite: true, meta: m.toolMeta ?? null });
      } catch { /* skip malformed */ }
    }
    return out;
  }

  listSkills(): Array<{ skillId: string; title: string; category: string; source: string; enabled: boolean; description: string | null; sortOrder: number; updatedAt: string; allowWrite: boolean; readOnly: boolean | null; serverId: string | null; serverName: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM skill_registry ORDER BY sort_order, skill_id`).all() as Record<string, unknown>[];
    return rows.map((r) => {
      // read/write: prefer the dedicated column (set for local + remote);
      // fall back to legacy remote_meta.readOnly for rows seeded before the
      // column existed.
      let readOnly: boolean | null = r.read_only === null || r.read_only === undefined ? null : Number(r.read_only) === 1;
      let serverId: string | null = null;
      let serverName: string | null = null;
      if (r.remote_meta) {
        try {
          const m = JSON.parse(String(r.remote_meta));
          if (readOnly === null && typeof m.readOnly === "boolean") readOnly = m.readOnly;
          if (typeof m.serverId === "string") serverId = m.serverId;
          if (typeof m.serverName === "string") serverName = m.serverName;
        } catch { /* ignore */ }
      }
      return {
        skillId: String(r.skill_id),
        title: String(r.title),
        category: String(r.category),
        source: String(r.source),
        enabled: Number(r.enabled) === 1,
        description: r.description ? String(r.description) : null,
        sortOrder: Number(r.sort_order),
        updatedAt: String(r.updated_at),
        allowWrite: Number(r.allow_write) === 1,
        readOnly,
        serverId,
        serverName
      };
    });
  }

  /** Replace the stored UI resources for a remote server (set at discovery time). */
  setRemoteResourcesForServer(serverId: string, resources: Array<{ uri: string; name?: string | null; title?: string | null; description?: string | null; mimeType?: string | null; meta?: Record<string, unknown> | null }>): void {
    this.db.prepare(`DELETE FROM remote_resources WHERE server_id = ?`).run(serverId);
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO remote_resources (server_id, uri, name, title, description, mime_type, meta_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = nowIso();
    for (const r of resources) {
      if (!r.uri) continue;
      stmt.run(serverId, r.uri, r.name ?? null, r.title ?? null, r.description ?? null, r.mimeType ?? null, r.meta ? JSON.stringify(r.meta) : null, now);
    }
  }

  /** All UI resources for the given remote server ids (for MCP Apps passthrough). */
  getRemoteResourcesForServers(serverIds: Set<string>): Array<{ serverId: string; uri: string; name: string | null; title: string | null; description: string | null; mimeType: string | null; meta: Record<string, unknown> | null }> {
    if (serverIds.size === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM remote_resources`).all() as Record<string, unknown>[];
    const out = [];
    for (const r of rows) {
      const serverId = String(r.server_id);
      if (!serverIds.has(serverId)) continue;
      let meta: Record<string, unknown> | null = null;
      if (r.meta_json) { try { meta = JSON.parse(String(r.meta_json)); } catch { /* ignore */ } }
      out.push({
        serverId, uri: String(r.uri),
        name: r.name ? String(r.name) : null,
        title: r.title ? String(r.title) : null,
        description: r.description ? String(r.description) : null,
        mimeType: r.mime_type ? String(r.mime_type) : null,
        meta
      });
    }
    return out;
  }

  pruneRemoteResourcesForServer(serverId: string): number {
    const res = this.db.prepare(`DELETE FROM remote_resources WHERE server_id = ?`).run(serverId);
    return Number(res.changes);
  }

  // ── Upstream MCP server configs (console-managed; merged with env at runtime) ──
  listRemoteServerConfigs() {
    const rows = this.db.prepare(`SELECT * FROM remote_servers ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      url: String(r.url),
      description: String(r.description),
      transport: (r.transport === "stdio" ? "stdio" : "http") as "http" | "stdio",
      command: r.command ? String(r.command) : undefined,
      args: r.args_json ? (JSON.parse(String(r.args_json)) as string[]) : undefined,
      env: r.env_json ? (JSON.parse(String(r.env_json)) as Record<string, string>) : undefined,
      bearerTokenEnv: r.bearer_token_env ? String(r.bearer_token_env) : undefined,
      bearerToken: r.bearer_token ? String(r.bearer_token) : undefined,
      headers: r.headers_json ? (JSON.parse(String(r.headers_json)) as Record<string, string>) : undefined,
      enabled: Number(r.enabled) === 1,
      oauthClientId: r.oauth_client_id ? String(r.oauth_client_id) : undefined,
      oauthClientSecret: r.oauth_client_secret ? String(r.oauth_client_secret) : undefined,
      oauthClientInfo: r.oauth_client_info_json ? (JSON.parse(String(r.oauth_client_info_json)) as Record<string, unknown>) : undefined,
      oauthTokens: r.oauth_tokens_json ? (JSON.parse(String(r.oauth_tokens_json)) as Record<string, unknown>) : undefined,
      oauthCodeVerifier: r.oauth_code_verifier ? String(r.oauth_code_verifier) : undefined,
      oauthState: r.oauth_state ? String(r.oauth_state) : undefined,
      oauthRedirectUri: r.oauth_redirect_uri ? String(r.oauth_redirect_uri) : undefined
    }));
  }

  upsertRemoteServerConfig(input: {
    id: string; name: string; url: string; description: string;
    transport?: "http" | "stdio"; command?: string; args?: string[]; env?: Record<string, string>;
    bearerTokenEnv?: string; bearerToken?: string; headers?: Record<string, string>; enabled?: boolean;
    oauthClientId?: string; oauthClientSecret?: string;
  }) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO remote_servers (id, name, url, description, transport, command, args_json, env_json, bearer_token_env, bearer_token, headers_json, enabled, oauth_client_id, oauth_client_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, description=excluded.description,
        transport=excluded.transport, command=excluded.command, args_json=excluded.args_json, env_json=excluded.env_json,
        bearer_token_env=excluded.bearer_token_env, bearer_token=excluded.bearer_token, headers_json=excluded.headers_json,
        enabled=excluded.enabled, oauth_client_id=excluded.oauth_client_id, oauth_client_secret=excluded.oauth_client_secret,
        updated_at=excluded.updated_at
    `).run(
      input.id, input.name, input.url, input.description,
      input.transport ?? "http", input.command ?? null,
      input.args ? JSON.stringify(input.args) : null,
      input.env ? JSON.stringify(input.env) : null,
      input.bearerTokenEnv ?? null, input.bearerToken ?? null,
      input.headers ? JSON.stringify(input.headers) : null,
      input.enabled === false ? 0 : 1,
      input.oauthClientId ?? null, input.oauthClientSecret ?? null,
      now, now
    );
  }

  /** Partial update of a server's OAuth flow state; `null` clears a column, undefined leaves it. */
  updateRemoteServerOauth(id: string, patch: {
    clientInfoJson?: string | null; tokensJson?: string | null;
    codeVerifier?: string | null; state?: string | null; redirectUri?: string | null;
  }): boolean {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    const map: Array<[keyof typeof patch, string]> = [
      ["clientInfoJson", "oauth_client_info_json"],
      ["tokensJson", "oauth_tokens_json"],
      ["codeVerifier", "oauth_code_verifier"],
      ["state", "oauth_state"],
      ["redirectUri", "oauth_redirect_uri"]
    ];
    for (const [key, col] of map) {
      if (patch[key] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[key] as string | null); }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    vals.push(nowIso());
    const res = this.db.prepare(`UPDATE remote_servers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return Number(res.changes) > 0;
  }

  findRemoteServerIdByOauthState(state: string): string | null {
    const row = this.db.prepare(`SELECT id FROM remote_servers WHERE oauth_state = ?`).get(state) as { id: string } | undefined;
    return row ? row.id : null;
  }

  deleteRemoteServerConfig(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM remote_servers WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  /**
   * Enable a remote server's READ tools when it's added (add server = use it).
   * Write tools (read_only = 0) are left OFF so a remote can't mutate anything
   * until the operator explicitly flips its toggle.
   */
  enableRemoteSkillsForServer(serverId: string): number {
    const res = this.db.prepare(`UPDATE skill_registry SET enabled = 1, updated_at = ? WHERE source = 'remote-mcp' AND skill_id LIKE ? AND (read_only IS NULL OR read_only = 1)`)
      .run(nowIso(), `rmcp__${serverId}__%`);
    return Number(res.changes);
  }

  /** Remove orphaned remote skills for a deleted server (prefix rmcp__<serverId>__). */
  pruneRemoteSkillsForServer(serverId: string): number {
    const prefix = `rmcp__${serverId}__`;
    const res = this.db.prepare(`DELETE FROM skill_registry WHERE source = 'remote-mcp' AND skill_id LIKE ?`).run(`${prefix}%`);
    return Number(res.changes);
  }

  /** Persist display order: assign sort_order = position for the given ids. */
  reorderSkills(orderedIds: string[]): void {
    const stmt = this.db.prepare(`UPDATE skill_registry SET sort_order = ?, updated_at = ? WHERE skill_id = ?`);
    const now = nowIso();
    orderedIds.forEach((id, i) => stmt.run(i, now, id));
  }

  setSkillAllowWrite(skillId: string, allow: boolean): boolean {
    const res = this.db.prepare(`UPDATE skill_registry SET allow_write = ?, updated_at = ? WHERE skill_id = ?`)
      .run(allow ? 1 : 0, nowIso(), skillId);
    return Number(res.changes) > 0;
  }

  /**
   * Drop local skill rows no longer present in the code (keeps the registry in
   * sync with the catalog; prevents "ghost" tools lingering in the console).
   * Remote rows are managed separately (by server add/remove).
   */
  reconcileLocalSkills(validIds: Set<string>): number {
    const rows = this.db.prepare(`SELECT skill_id FROM skill_registry WHERE source = 'local'`).all() as { skill_id: string }[];
    let removed = 0;
    for (const r of rows) {
      if (!validIds.has(r.skill_id)) {
        this.db.prepare(`DELETE FROM skill_registry WHERE skill_id = ?`).run(r.skill_id);
        this.db.prepare(`DELETE FROM skill_visibility WHERE skill_id = ?`).run(r.skill_id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Set of enabled skill ids — used by tools/list filtering. */
  getEnabledSkillIds(): Set<string> {
    const rows = this.db.prepare(`SELECT skill_id FROM skill_registry WHERE enabled = 1`).all() as { skill_id: string }[];
    return new Set(rows.map((r) => r.skill_id));
  }

  setSkillEnabled(skillId: string, enabled: boolean): boolean {
    const res = this.db.prepare(`UPDATE skill_registry SET enabled = ?, updated_at = ? WHERE skill_id = ?`)
      .run(enabled ? 1 : 0, nowIso(), skillId);
    return Number(res.changes) > 0;
  }

  // ── Per-agent skill visibility (allowlist mode) ─────────────────────────

  /** Skill ids explicitly allowed for an agent (visible=1 rows). */
  getAgentAllowlist(agentId: string): Set<string> {
    const rows = this.db.prepare(`SELECT skill_id FROM skill_visibility WHERE agent_id = ? AND visible = 1`).all(agentId) as { skill_id: string }[];
    return new Set(rows.map((r) => r.skill_id));
  }

  /**
   * Replace an agent's allowlist. Empty list → agent reverts to "inherit"
   * (sees all globally-enabled skills). Non-empty → allowlist mode.
   */
  setAgentAllowlist(agentId: string, skillIds: string[]): void {
    this.db.prepare(`DELETE FROM skill_visibility WHERE agent_id = ?`).run(agentId);
    const stmt = this.db.prepare(`INSERT INTO skill_visibility (agent_id, skill_id, visible, updated_at) VALUES (?, ?, 1, ?)`);
    const now = nowIso();
    for (const id of skillIds) stmt.run(agentId, id, now);
  }

  /** True if the agent is in allowlist mode (has any explicit rows). */
  agentHasAllowlist(agentId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM skill_visibility WHERE agent_id = ? LIMIT 1`).get(agentId);
    return !!row;
  }

  /**
   * Effective set of skills visible to an agent for tools/list:
   * - globally enabled skills, AND
   * - if the agent has an allowlist, intersect with it.
   */
  getVisibleSkillIdsForAgent(agentId: string): Set<string> {
    const enabled = this.getEnabledSkillIds();
    const allow = this.getAgentAllowlist(agentId);
    if (this.agentHasAllowlist(agentId)) {
      return new Set([...enabled].filter((id) => allow.has(id)));
    }
    return enabled;
  }

  /** True if the registry has any rows (i.e., has been seeded). */
  hasSkills(): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM skill_registry`).get() as { c: number };
    return row.c > 0;
  }

  /** Periodic cleanup of expired pending/codes/tokens. */
  gc(): void {
    const now = nowIso();
    this.db.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ? OR consumed = 1`).run(now);
    this.db.prepare(`DELETE FROM oauth_access_tokens WHERE expires_at < ? AND revoked = 1`).run(now);
  }

  close(): void {
    this.db.close();
  }
}
