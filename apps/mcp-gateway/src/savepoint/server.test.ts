import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { SavepointStore } from "./store.js";
import { createSavepointServer } from "./server.js";

test("MCP catalog, calls, validation and handled conflicts work through the SDK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "savepoint-mcp-"));
  const store = new SavepointStore(join(dir, "vault.sqlite"));
  const server = createSavepointServer(store);
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 6);
    assert.equal(catalog.tools.find((x) => x.name === "checkpoint")!.annotations!.readOnlyHint, false);
    const created = await client.callTool({ name: "create_task", arguments: { title: "Test", goal: "Resume", requestId: "c" } });
    const taskId = (created.structuredContent as { taskId: string }).taskId;
    const saved = await client.callTool({ name: "checkpoint", arguments: { taskId, requestId: "s", expectedRevision: 0, summary: "Done", nextSteps: [] } });
    assert.equal((saved.structuredContent as { revision: number }).revision, 1);
    const conflict = await client.callTool({ name: "checkpoint", arguments: { taskId, requestId: "stale", expectedRevision: 0, summary: "Lost update", nextSteps: [] } });
    assert.equal(conflict.isError, true);
    const invalid = await client.callTool({ name: "resume_task", arguments: { taskId: "bad" } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real stdio process survives restart and CLI exports a non-overwriting backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "savepoint-stdio-"));
  const path = join(dir, "vault.sqlite");
  const cli = process.env.SAVEPOINT_TEST_CLI ?? fileURLToPath(new URL("../cli/savepoint.ts", import.meta.url));
  const args = [...(process.env.SAVEPOINT_TEST_CLI ? [] : ["--import", "tsx"]), cli, "--db", path];
  const connect = async () => {
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" }));
    return client;
  };
  let client: Client | undefined;
  try {
    client = await connect();
    const created = await client.callTool({ name: "create_task", arguments: { title: "Restart", goal: "Persist", requestId: "new" } });
    const taskId = (created.structuredContent as { taskId: string }).taskId;
    await client.callTool({ name: "checkpoint", arguments: { taskId, requestId: "save", expectedRevision: 0, summary: "Saved", nextSteps: ["Review"], artifacts: [{ path: "hello.txt", encoding: "utf8", content: "persist me" }] } });
    await client.close();
    client = await connect();
    const resumed = await client.callTool({ name: "resume_task", arguments: { taskId } });
    assert.equal((resumed.structuredContent as { revision: number }).revision, 1);
    await client.close(); client = undefined;
    const out = join(dir, "backup.json");
    const exportArgs = [...args, "--export", taskId, "--output", out];
    const exported = spawnSync(process.execPath, exportArgs, { encoding: "utf8", timeout: 15_000 });
    assert.equal(exported.status, 0, exported.stderr);
    const json = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(Buffer.from(json.files[0].content, "base64").toString(), "persist me");
    assert.notEqual(spawnSync(process.execPath, exportArgs, { timeout: 15_000 }).status, 0);
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});
