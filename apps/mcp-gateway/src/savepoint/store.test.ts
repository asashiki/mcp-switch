import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SavepointStore } from "./store.js";

function fixture(t: { after(fn: () => void): void }, quota?: number) {
  const dir = mkdtempSync(join(tmpdir(), "savepoint-"));
  const path = join(dir, "vault.sqlite");
  const store = new SavepointStore(path, quota);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = store.create({ title: "音乐组件", goal: "Fix playback", requestId: "new" });
  const save = (extra: Record<string, unknown> = {}) => store.checkpoint({
    taskId: task.taskId, requestId: "save", expectedRevision: 0,
    summary: "Audio implementation saved", nextSteps: ["Test in host"],
    artifacts: [{ path: "src/audio.ts", encoding: "utf8", content: "你好 🎵" }], ...extra
  });
  return { store, path, task, save };
}

test("persists actual artifact bytes across a second connection and pins history", (t) => {
  const { store, path, task, save } = fixture(t);
  save();
  const reader = new SavepointStore(path);
  try {
    assert.equal(reader.resume({ taskId: task.taskId }).revision, 1);
    const bytes = reader.read({ taskId: task.taskId, revision: 1, path: "src/audio.ts" });
    assert.equal(Buffer.from(bytes.content, "base64").toString(), "你好 🎵");
    save({ requestId: "save2", expectedRevision: 1, artifacts: [], removePaths: ["src/audio.ts"] });
    assert.deepEqual(store.resume({ taskId: task.taskId }).artifacts, {});
    assert.equal(reader.read({ taskId: task.taskId, revision: 1, path: "src/audio.ts" }).sha256, bytes.sha256);
    assert.equal(reader.resume({ taskId: task.taskId, revision: 0 }).revision, 0);
  } finally { reader.close(); }
});

test("create and checkpoint retries return original receipts after newer writes", (t) => {
  const { store, task, save } = fixture(t);
  const first = save();
  save({ requestId: "next", expectedRevision: 1 });
  assert.deepEqual(save(), first);
  assert.deepEqual(store.create({ title: "音乐组件", goal: "Fix playback", requestId: "new" }), task);
  assert.throws(() => save({ summary: "Different payload" }), { code: "idempotency_conflict" });
  assert.throws(() => store.create({ title: "Other", goal: "Fix playback", requestId: "new" }), { code: "idempotency_conflict" });
});

test("stale writers cannot overwrite each other", (t) => {
  const { store, path, task, save } = fixture(t);
  const second = new SavepointStore(path);
  try {
    save();
    assert.throws(() => second.checkpoint({ taskId: task.taskId, requestId: "other", expectedRevision: 0, summary: "stale", nextSteps: [] }), { code: "revision_conflict" });
    assert.equal(store.resume({ taskId: task.taskId }).summary, "Audio implementation saved");
  } finally { second.close(); }
});

test("failed transaction rolls back blobs, revision and retry receipt", (t) => {
  const { store, path, task, save } = fixture(t, 2);
  assert.throws(() => save(), { code: "quota_exceeded" });
  assert.equal(store.resume({ taskId: task.taskId }).revision, 0);
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM savepoint_blobs").get()!.n, 0); }
  finally { db.close(); }
  assert.equal(save({ artifacts: [{ path: "x", encoding: "utf8", content: "ok" }] }).revision, 1);
});

test("deduplicates identical bytes while retaining binary content", (t) => {
  const { store, path, task, save } = fixture(t, 3);
  const binary = Buffer.from([0, 255, 1]).toString("base64");
  save({ artifacts: ["a", "b"].map((path) => ({ path, encoding: "base64", content: binary })) });
  assert.equal(store.read({ taskId: task.taskId, revision: 1, path: "b" }).content, binary);
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM savepoint_blobs").get()!.n, 1); }
  finally { db.close(); }
});

test("rejects traversal, ambiguous paths, invalid base64, duplicate and oversized uploads", (t) => {
  const { save } = fixture(t);
  for (const path of ["../secret", "/etc/passwd", "C:/secret", "a\\b", "a//b", "./a", "a/../b", "a\u0000b"]) {
    assert.throws(() => save({ artifacts: [{ path, encoding: "utf8", content: "x" }] }));
  }
  assert.throws(() => save({ artifacts: [{ path: "a", encoding: "base64", content: "!!!" }] }), { code: "invalid_base64" });
  assert.throws(() => save({ removePaths: ["src/audio.ts"] }), { code: "duplicate_path" });
  assert.throws(() => save({ artifacts: [{ path: "a", encoding: "utf8", content: "x".repeat(524289) }] }), { code: "payload_too_large" });
  assert.throws(() => save({ artifacts: Array.from({ length: 5 }, (_, i) => ({ path: String(i), encoding: "utf8", content: "x".repeat(524288) })) }), { code: "payload_too_large" });
});

test("paths resembling object properties are ordinary artifacts", (t) => {
  const { store, task, save } = fixture(t);
  save({ artifacts: [{ path: "__proto__", encoding: "utf8", content: "plain data" }] });
  assert.equal(store.read({ taskId: task.taskId, revision: 1, path: "__proto__" }).bytes, 10);
  assert.throws(() => store.read({ taskId: task.taskId, revision: 1, path: "constructor" }), { code: "not_found" });
});

test("artifact integrity failures are surfaced instead of returning corrupt bytes", (t) => {
  const { store, path, task, save } = fixture(t);
  save();
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE savepoint_blobs SET data=?").run(Buffer.from("corrupt")); }
  finally { db.close(); }
  assert.throws(() => store.read({ taskId: task.taskId, revision: 1, path: "src/audio.ts" }), { code: "integrity_error" });
});

test("handoff stays pinned, export contains bytes, and tasks paginate", (t) => {
  const { store, task, save } = fixture(t);
  save();
  const packet = store.handoff({ taskId: task.taskId, target: "Reviewer", assignment: "Review playback" });
  save({ requestId: "second", expectedRevision: 1 });
  assert.equal(packet.snapshot.revision, 1);
  assert.equal(packet.delivery, "not_sent");
  assert.equal(store.export({ taskId: task.taskId, revision: 1 }).files.length, 1);
  store.create({ title: "Another", goal: "A separate goal", requestId: "another" });
  const first = store.list({ limit: 1 });
  const second = store.list({ limit: 1, after: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert.notEqual(first.tasks[0]!.taskId, second.tasks[0]!.taskId);
});
