import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { AuthStore } from "./store.js";

function freshStore(t: TestContext): AuthStore {
  const path = join(tmpdir(), `authstore-${randomUUID()}.sqlite`);
  const store = new AuthStore(path);
  t.after(() => { store.close(); try { rmSync(path); } catch { /* ignore */ } });
  return store;
}

const TTL = { accessTtlSeconds: 3600, refreshTtlSeconds: 3600, codeTtlSeconds: 300, pendingTtlSeconds: 600 };

function pkcePair() {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── agents ──
test("agent: create returns secret once, verify, disable revokes", (t) => {
  const s = freshStore(t);
  const { secret } = s.upsertAgent("claude-ai", "Claude.ai");
  assert.ok(secret && secret.startsWith("amcp_sk_"));
  // idempotent: second upsert returns null secret
  assert.equal(s.upsertAgent("claude-ai", "Claude.ai").secret, null);
  assert.ok(s.verifyAgentSecret("claude-ai", secret!));
  assert.ok(!s.verifyAgentSecret("claude-ai", "wrong"));
  s.setAgentEnabled("claude-ai", false);
  assert.ok(!s.verifyAgentSecret("claude-ai", secret!), "disabled agent fails secret check");
});

// ── full OAuth code→token flow + PKCE ──
test("oauth: authorize→code→token, single-use code, PKCE enforced", (t) => {
  const s = freshStore(t);
  const client = s.registerClient("Test", ["https://app/cb"]);
  const { verifier, challenge } = pkcePair();
  const code = s.issueCode({
    clientId: client.clientId, agentId: "claude-ai", redirectUri: "https://app/cb",
    codeChallenge: challenge, codeChallengeMethod: "S256", scope: "tools", ttlSeconds: 300
  });
  const rec = s.consumeCode(code);
  assert.ok(rec);
  assert.equal(rec!.agentId, "claude-ai");
  // verifier matches the stored challenge (caller verifies PKCE separately)
  assert.equal(createHash("sha256").update(verifier).digest("base64url").length, challenge.length);
  // single-use: second consume returns null
  assert.equal(s.consumeCode(code), null);
});

// ── refresh rotation + replay revokes chain ──
test("oauth: refresh rotates; replay revokes the chain", (t) => {
  const s = freshStore(t);
  s.upsertAgent("claude-ai", "Claude.ai");
  const pair = s.issueTokenPair({ clientId: "c1", agentId: "claude-ai", scope: "tools", accessTtlSeconds: 3600, refreshTtlSeconds: 3600 });
  assert.ok(s.validateAccessToken(pair.accessToken));

  const rotated = s.rotateRefreshToken(pair.refreshToken, TTL);
  assert.ok(!("error" in rotated), "first rotation succeeds");

  // replay the now-consumed refresh token → error + chain revoked
  const replay = s.rotateRefreshToken(pair.refreshToken, TTL);
  assert.ok("error" in replay && replay.error === "replayed");

  // the rotated refresh token is now also revoked (whole chain)
  const afterReplay = !("error" in rotated) ? s.rotateRefreshToken(rotated.refreshToken, TTL) : null;
  assert.ok(afterReplay && "error" in afterReplay, "chain revoked after replay");
});

test("oauth: access token invalid after agent disabled / revoked", (t) => {
  const s = freshStore(t);
  s.upsertAgent("claude-ai", "Claude.ai");
  const pair = s.issueTokenPair({ clientId: "c1", agentId: "claude-ai", scope: "tools", accessTtlSeconds: 3600, refreshTtlSeconds: 3600 });
  s.setAgentEnabled("claude-ai", false);
  assert.equal(s.validateAccessToken(pair.accessToken), null, "disabled agent's token rejected");
  // Re-enabling does NOT resurrect revoked tokens — client must re-authorize.
  s.setAgentEnabled("claude-ai", true);
  assert.equal(s.validateAccessToken(pair.accessToken), null, "tokens stay revoked after re-enable");
  // A fresh token works again.
  const fresh = s.issueTokenPair({ clientId: "c1", agentId: "claude-ai", scope: "tools", accessTtlSeconds: 3600, refreshTtlSeconds: 3600 });
  assert.ok(s.validateAccessToken(fresh.accessToken));
  s.revokeToken(fresh.accessToken);
  assert.equal(s.validateAccessToken(fresh.accessToken), null, "revoked token rejected");
});

// ── skill registry ──
test("registry: seed idempotent (never resets enabled), enable/disable, filter", (t) => {
  const s = freshStore(t);
  s.seedSkill({ skillId: "a", title: "A", category: "x", enabled: true });
  s.seedSkill({ skillId: "b", title: "B", category: "x", enabled: false });
  assert.deepEqual([...s.getEnabledSkillIds()].sort(), ["a"]);
  // user disables a via console
  s.setSkillEnabled("a", false);
  // re-seed (startup) must NOT re-enable a
  s.seedSkill({ skillId: "a", title: "A", category: "x", enabled: true });
  assert.ok(!s.getEnabledSkillIds().has("a"), "re-seed preserves console toggle");
});

// ── per-agent visibility (allowlist) ──
test("visibility: inherit by default, allowlist narrows, capped by global enable", (t) => {
  const s = freshStore(t);
  s.seedSkill({ skillId: "voice", title: "V", category: "action", enabled: true });
  s.seedSkill({ skillId: "x", title: "X", category: "search", enabled: true });
  s.seedSkill({ skillId: "off", title: "O", category: "x", enabled: false });

  // no allowlist → inherits all enabled
  assert.deepEqual([...s.getVisibleSkillIdsForAgent("a")].sort(), ["voice", "x"]);
  assert.ok(!s.agentHasAllowlist("a"));

  // allowlist → only listed, still capped by global enabled ("off" excluded)
  s.setAgentAllowlist("a", ["voice", "off"]);
  assert.ok(s.agentHasAllowlist("a"));
  assert.deepEqual([...s.getVisibleSkillIdsForAgent("a")], ["voice"]);

  // clear allowlist → back to inherit
  s.setAgentAllowlist("a", []);
  assert.ok(!s.agentHasAllowlist("a"));
  assert.deepEqual([...s.getVisibleSkillIdsForAgent("a")].sort(), ["voice", "x"]);
});

// ── console admin + sessions ──
test("console: admin login + session lifecycle", (t) => {
  const s = freshStore(t);
  s.setConsoleAdmin("admin", "pw123");
  assert.ok(s.verifyConsoleAdmin("admin", "pw123"));
  assert.ok(!s.verifyConsoleAdmin("admin", "nope"));
  const token = s.createConsoleSession("admin", 3600);
  assert.equal(s.validateConsoleSession(token), "admin");
  s.deleteConsoleSession(token);
  assert.equal(s.validateConsoleSession(token), null);
});

// ── remote-mcp skills ──
test("remote: seed with meta, descriptors (enable = write opt-in), prune by server", (t) => {
  const s = freshStore(t);
  s.seedSkill({
    skillId: "rmcp__srv__echo", title: "srv: echo", category: "remote", source: "remote-mcp", enabled: true,
    readOnly: true,
    remoteMeta: { serverId: "srv", toolName: "echo", inputSchema: { type: "object" }, readOnly: true }
  });
  s.seedSkill({
    skillId: "rmcp__srv__write", title: "srv: write", category: "remote", source: "remote-mcp", enabled: true,
    readOnly: false,
    remoteMeta: { serverId: "srv", toolName: "write", inputSchema: {}, readOnly: false }
  });
  const enabled = s.getEnabledSkillIds();
  const descs = s.getRemoteDescriptors(enabled);
  assert.equal(descs.length, 2);
  // The per-tool allow_write sub-toggle is gone: enabling a remote skill IS the
  // write opt-in, so every enabled descriptor forwards allowWrite=true.
  const writeDesc = descs.find((d) => d.toolName === "write")!;
  assert.equal(writeDesc.allowWrite, true, "enabled write tool forwards allowWrite");
  // readOnly surfaced in listSkills (from the dedicated column)
  const listed = s.listSkills().find((x) => x.skillId === "rmcp__srv__echo")!;
  assert.equal(listed.readOnly, true);
  const listedWrite = s.listSkills().find((x) => x.skillId === "rmcp__srv__write")!;
  assert.equal(listedWrite.readOnly, false);
  // prune removes the server's skills
  const removed = s.pruneRemoteSkillsForServer("srv");
  assert.equal(removed, 2);
  assert.equal(s.getRemoteDescriptors(new Set(["rmcp__srv__echo", "rmcp__srv__write"])).length, 0);
});

// ── console skill groups ──
test("skill groups: per-user persistence, overwrite, empty default", (t) => {
  const s = freshStore(t);
  assert.deepEqual(s.getSkillGroups("admin"), []);
  const groups = [
    { id: "g1", name: "日常感知", order: 0, skillIds: ["device_status", "weather_current"] },
    { id: "g2", name: "写作", order: 1, skillIds: ["diary_write"] }
  ];
  s.setSkillGroups("admin", groups);
  assert.deepEqual(s.getSkillGroups("admin"), groups);
  // overwrite replaces wholesale
  s.setSkillGroups("admin", [groups[1]!]);
  assert.deepEqual(s.getSkillGroups("admin"), [groups[1]]);
  // other users isolated
  assert.deepEqual(s.getSkillGroups("other"), []);
});

test("skill groups: merged name map (first claim wins) for tools/list prefixing", (t) => {
  const s = freshStore(t);
  assert.equal(s.getSkillGroupNameMap().size, 0);
  s.setSkillGroups("admin", [
    { id: "g1", name: "日常感知", order: 0, skillIds: ["device_status", "weather_current"] }
  ]);
  s.setSkillGroups("other", [
    { id: "g9", name: "别名组", order: 0, skillIds: ["device_status", "x_search"] }
  ]);
  const map = s.getSkillGroupNameMap();
  assert.equal(map.get("weather_current"), "日常感知");
  assert.equal(map.get("x_search"), "别名组");
  // both users claim device_status — first row wins, no throw
  assert.ok(map.has("device_status"));
});

// ── audit stats ──
test("audit stats: totals, latency percentiles, top tools, by agent, prev window", (t) => {
  const s = freshStore(t);
  s.seedSkill({ skillId: "device_status", title: "Device Status", category: "realtime", enabled: true });
  s.upsertAgent("claude-ai", "Claude.ai");
  for (let i = 0; i < 8; i++) {
    s.audit({ agentId: "claude-ai", toolName: "device_status", action: "tool_call", success: true, latencyMs: 10 + i });
  }
  s.audit({ agentId: "claude-ai", toolName: "x_search", action: "tool_call", success: false, latencyMs: 900 });
  s.audit({ action: "mcp_unauthorized", success: false });
  s.audit({ agentId: "claude-ai", action: "mcp_request", success: true }); // not a tool_call → excluded

  const st = s.auditStats(3600, 300);
  assert.equal(st.totalCalls, 9);
  assert.equal(st.errorCalls, 1);
  assert.equal(st.unauthorizedCalls, 1);
  assert.ok(st.p50LatencyMs >= 10 && st.p50LatencyMs <= 20);
  assert.equal(st.p95LatencyMs, 900);
  assert.equal(st.topTools[0]!.skillId, "device_status");
  assert.equal(st.topTools[0]!.title, "Device Status", "joins skill_registry title");
  assert.equal(st.topTools[0]!.count, 8);
  assert.equal(st.byAgent[0]!.agentId, "claude-ai");
  assert.equal(st.byAgent[0]!.count, 9);
  assert.equal(st.timeline.reduce((a, b) => a + b.n, 0), 9, "timeline buckets sum to total");
  // previous window has no data
  const prev = s.auditStats(3600, 300, 3600);
  assert.equal(prev.totalCalls, 0);
});
