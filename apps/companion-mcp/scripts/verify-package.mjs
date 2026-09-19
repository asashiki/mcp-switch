import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const archive = resolve(
  process.argv[2] || "artifacts/companion-mcp-runtime.tar.gz",
);
const temp = await mkdtemp(join(tmpdir(), "companion-package-test-"));
execFileSync("tar", ["-xzf", archive, "-C", temp]);
const cwd = join(temp, "companion-mcp");
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: "Bearer runtime-smoke-secret" };
let child,
  logs = "";
async function start() {
  const env = {
    ...process.env,
    COMPANION_PORT: String(port),
    COMPANION_PUBLIC_URL: base,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_TOKEN: "runtime-smoke-secret",
    COMPANION_ALLOWED_HOSTS: "companion",
    COMPANION_DATA_DIR: join(cwd, "data"),
    COMPANION_CHARACTERS: join(cwd, "examples/characters.json"),
    COMPANION_GENERATION_ENABLED: "false",
    NOVELAI_API_TOKEN: "",
  };
  // The executable must not resolve packages from our source checkout or runtime preload paths.
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  child = spawn(process.execPath, ["dist/server.mjs"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error(`Packaged server exited: ${logs}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `Packaged server did not start: ${logs}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
async function client() {
  const c = new Client(
    { name: "runtime-smoke", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: auth },
    }),
  );
  return c;
}
try {
  assert.ok(!(await readdir(cwd)).includes("node_modules"));
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  await start();
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  for (const route of ["/admin", "/stage"])
    assert.match(
      await fetch(`${base}${route}`).then((r) => r.text()),
      /<script>/,
    );
  const config = await fetch(`${base}/api/config`, { headers: auth }).then(
    (r) => r.json(),
  );
  assert.equal(config.providerConfigured, false);
  const c = await client();
  let sessionId;
  try {
    assert.equal(c.getNegotiatedProtocolVersion(), "2026-07-28");
    const catalog = await c.listTools();
    assert.equal(catalog.tools.length, 6);
    const open = await c.callTool({
      name: "open_companion",
      arguments: {
        character_id: "alice",
        mode: "avatar",
        event_id: randomUUID(),
      },
    });
    assert.ok(!open.isError, JSON.stringify(open));
    sessionId = open.structuredContent.sessionId;
    const turn = await c.callTool({
      name: "perform_turn",
      arguments: {
        session_id: sessionId,
        event_id: "runtime-turn",
        expected_revision: 0,
        expression: "smile",
        line: "运行包恢复测试",
      },
    });
    assert.ok(!turn.isError);
    assert.equal(turn.structuredContent.revision, 1);
    const preview = await c.callTool({
      name: "request_illustration",
      arguments: {
        session_id: sessionId,
        revision: 1,
        event_id: "preview",
        composition: "medium shot",
        generate: false,
      },
    });
    assert.ok(!preview.isError);
    assert.match(preview.structuredContent.preview.input, /silver gray hair/);
    const blocked = await c.callTool({
      name: "request_illustration",
      arguments: {
        session_id: sessionId,
        revision: 1,
        event_id: "blocked",
        composition: "medium shot",
        generate: true,
      },
    });
    assert.equal(blocked.isError, true);
    const resource = await c.readResource({
      uri: "ui://companion/stage-v1.html",
    });
    assert.match(resource.contents[0].text, /角色场景/);
  } finally {
    await c.close();
  }
  await stop();
  await start();
  const restored = await client();
  try {
    const scene = await restored.callTool({
      name: "get_scene",
      arguments: { session_id: sessionId },
    });
    assert.ok(!scene.isError);
    assert.equal(scene.structuredContent.line, "运行包恢复测试");
    assert.equal(scene.structuredContent.revision, 1);
  } finally {
    await restored.close();
  }
  console.log(
    JSON.stringify({
      archive,
      passed: true,
      checks: [
        "no node_modules or runtime dependencies",
        "health and authenticated config",
        "HTML assets",
        "MCP discovery and scene update",
        "NAI preview without credentials",
        "paid generation blocked",
        "UI resource",
        "restart persistence",
      ],
    }),
  );
} finally {
  await stop();
  await rm(temp, { recursive: true, force: true });
}
