import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacters, loadConfig } from "../src/config.js";
import { Companion } from "../src/service.js";
import { compilePrompt, generate } from "../src/novelai.js";
import { createHttp } from "../src/http.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpGatewayApp,
  loadMcpGatewayEnv,
} from "../../mcp-gateway/src/app.js";
const chars = loadCharacters(
  new URL("../examples/characters.json", import.meta.url).pathname,
);
function fixture(provider?: ConstructorParameters<typeof Companion>[2]) {
  const dir = mkdtempSync(join(tmpdir(), "companion-"));
  const cfg = loadConfig({
    COMPANION_DATA_DIR: dir,
    COMPANION_TOKEN: "test-secret",
    COMPANION_GENERATION_ENABLED: "true",
    NOVELAI_API_TOKEN: "fake",
    COMPANION_DAILY_LIMIT: "2",
  });
  const service = new Companion(cfg, structuredClone(chars), provider);
  return {
    service,
    dir,
    async close() {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);
test("20 turns persist identity, revisions, old scenes, deduplication and ownership", async () => {
  const f = fixture();
  try {
    const s = f.service.store.open("alice-user", "start", chars[0]!, "avatar");
    assert.deepEqual(
      f.service.store.open("alice-user", "start", chars[0]!, "avatar"),
      s,
    );
    for (let i = 0; i < 20; i++) {
      const input = {
        sessionId: s.sessionId,
        eventId: `turn-${i}`,
        expectedRevision: i,
        line: `line ${i}`,
        expression: i % 2 ? "smile" : "neutral",
      };
      const next = f.service.store.perform("alice-user", input);
      assert.equal(next.revision, i + 1);
      assert.deepEqual(f.service.store.perform("alice-user", input), next);
    }
    assert.equal(f.service.store.scene("alice-user", s.sessionId).revision, 20);
    assert.equal(f.service.store.scene("alice-user", s.sessionId, 0).line, "");
    assert.throws(
      () => f.service.store.scene("other-user", s.sessionId),
      /not found/,
    );
    assert.throws(
      () =>
        f.service.store.perform("alice-user", {
          sessionId: s.sessionId,
          eventId: "conflict",
          expectedRevision: 0,
          line: "late",
        }),
      /Revision conflict/,
    );
    assert.throws(
      () =>
        f.service.store.perform("alice-user", {
          sessionId: s.sessionId,
          eventId: "turn-0",
          expectedRevision: 0,
          line: "changed",
        }),
      /different arguments/,
    );
    const edited = structuredClone(chars);
    edited[0]!.characterPrompt = "different hair";
    f.service.saveCharacters(edited);
    assert.equal(
      f.service.store.scene("alice-user", s.sessionId).character
        .characterPrompt,
      chars[0]!.characterPrompt,
    );
    await f.service.close();
    const restored = new Companion(f.service.config, chars);
    assert.equal(restored.store.scene("alice-user", s.sessionId).revision, 20);
    await restored.close();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("prompt separates fixed identity/style from scene and does not include private dialogue", async () => {
  const f = fixture();
  try {
    const s = f.service.store.open("personal", "start", chars[0]!, "role");
    s.line = "PRIVATE SECRET";
    s.action = "holding tea";
    const r = compilePrompt(s, "medium shot", 123);
    assert.equal(r.parameters.seed, 123);
    assert.match(r.parameters.v4_prompt.caption.base_caption, /medium shot/);
    assert.match(
      r.parameters.v4_prompt.caption.char_captions[0]!.char_caption,
      /silver gray hair/,
    );
    assert.match(r.input, /holding tea/);
    assert.ok(!JSON.stringify(r).includes("PRIVATE SECRET"));
  } finally {
    await f.close();
  }
});
test("generation is single-flight, duplicate-safe, budget bounded and never changes current scene", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fixture(async () => {
    calls++;
    await gate;
    return png;
  });
  try {
    const s = f.service.store.open("personal", "start", chars[0]!, "avatar");
    const a = {
      sessionId: s.sessionId,
      revision: 0,
      eventId: "cg",
      composition: "medium shot",
      generate: true,
    };
    const first = f.service.request("personal", a);
    const duplicate = f.service.request("personal", a);
    assert.equal(first.job!.id, duplicate.job!.id);
    f.service.store.perform("personal", {
      sessionId: s.sessionId,
      eventId: "next",
      expectedRevision: 0,
      line: "next",
      sceneId: "seaside_evening",
    });
    release();
    await f.service.worker.idle();
    assert.equal(calls, 1);
    assert.equal(
      f.service.store.scene("personal", s.sessionId).sceneId,
      "seaside_evening",
    );
    assert.equal(f.service.store.job("personal", first.job!.id).revision, 0);
    f.service.request("personal", { ...a, eventId: "cg2" });
    await f.service.worker.idle();
    assert.throws(
      () => f.service.request("personal", { ...a, eventId: "cg3" }),
      /limit/,
    );
    assert.equal(calls, 2);
    const url = new URL(
      f.service.jobView(
        f.service.store.job("personal", first.job!.id),
      ).imageUrl!,
    );
    assert.ok(
      f.service.verify(
        url.pathname,
        url.searchParams.get("expires"),
        url.searchParams.get("sig"),
      ),
    );
    assert.ok(
      !f.service.verify(
        "/media/other.png",
        url.searchParams.get("expires"),
        url.searchParams.get("sig"),
      ),
    );
  } finally {
    release();
    await f.close();
  }
});
test("interrupted requests are not replayed after restart", async () => {
  const f = fixture();
  const s = f.service.store.open("personal", "start", chars[0]!, "avatar");
  const job = f.service.store.enqueue(
    "personal",
    "cg",
    s,
    compilePrompt(s, "", 1),
    2,
  );
  job.status = "running";
  f.service.store.updateJob(job);
  await f.service.close();
  let calls = 0;
  const restored = new Companion(f.service.config, chars, async () => {
    calls++;
    return png;
  });
  try {
    await restored.worker.kick();
    assert.equal(calls, 0);
    assert.equal(restored.store.job("personal", job.id).status, "interrupted");
  } finally {
    await restored.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("provider uses JSON image contract and never retries HTTP errors", async () => {
  let calls = 0;
  const provider = (async (url, init) => {
    calls++;
    assert.equal(url, "https://image.novelai.net/ai/generate-image");
    assert.equal(
      (init!.headers as Record<string, string>).Accept,
      "application/json",
    );
    return new Response(
      JSON.stringify({ images: [{ image: png.toString("base64") }] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  assert.deepEqual(await generate("fake", {}, provider), png);
  assert.equal(calls, 1);
  await assert.rejects(
    generate("fake", {}, (async () => {
      calls++;
      return new Response("", { status: 429 });
    }) as typeof fetch),
    /429/,
  );
  assert.equal(calls, 2);
});
test("HTTP protects configuration, media and rejects hostile origins", async () => {
  const f = fixture();
  const app = createHttp(f.service);
  try {
    assert.equal((await app.inject({ url: "/api/config" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/api/config",
          headers: { authorization: "Bearer test-secret" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/config",
          headers: {
            authorization: "Bearer test-secret",
            origin: "https://evil.invalid",
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: "/media/missing.png" })).statusCode,
      403,
    );
    const result = await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "image/png",
      },
      payload: png,
    });
    assert.equal(result.statusCode, 200);
    const { url } = result.json();
    const parsed = new URL(url);
    assert.equal(
      (await app.inject({ url: parsed.pathname + parsed.search })).statusCode,
      200,
    );
  } finally {
    await app.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("real upstream and Switch preserve tools, scenes and UI in modern and legacy protocols", async () => {
  const f = fixture();
  const upstream = createHttp(f.service);
  const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const gateway = await createMcpGatewayApp({
    env: loadMcpGatewayEnv({
      NODE_ENV: "test",
      MCP_AUTH_DB_PATH: join(f.dir, "gateway.sqlite"),
      REMOTE_MCP_SERVERS_JSON: JSON.stringify([
        {
          id: "companion",
          name: "Companion",
          url: `${address}/mcp`,
          headers: { Authorization: "Bearer test-secret" },
        },
      ]),
    }),
  });
  // Enable explicitly write-labelled companion tools as an operator would in the console.
  for (const tool of gateway.store.listSkills())
    gateway.store.setSkillEnabled(tool.skillId, true);
  const proxy = await gateway.server.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const [base, prefix, modern] of [
      [address, "", true],
      [proxy, "rmcp__companion__", true],
      [proxy, "rmcp__companion__", false],
    ] as const) {
      const client = new Client(
        { name: "companion-integration", version: "1" },
        modern ? { versionNegotiation: { mode: "auto" } } : {},
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`${base}/mcp`),
            base === address
              ? {
                  requestInit: {
                    headers: { Authorization: "Bearer test-secret" },
                  },
                }
              : {},
          ),
        );
        const tools = await client.listTools();
        assert.ok(tools.tools.some((t) => t.name === `${prefix}perform_turn`));
        if (modern)
          assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
        else
          assert.notEqual(client.getNegotiatedProtocolVersion(), "2026-07-28");
        const opened = await client.callTool({
          name: `${prefix}open_companion`,
          arguments: {
            character_id: "alice",
            mode: "avatar",
            event_id: randomUUID(),
          },
        });
        assert.ok(!opened.isError, JSON.stringify(opened));
        const scene = opened.structuredContent as {
          sessionId: string;
          persona?: string;
        };
        assert.equal(scene.persona, undefined);
        const turn = await client.callTool({
          name: `${prefix}perform_turn`,
          arguments: {
            session_id: scene.sessionId,
            event_id: "1",
            expected_revision: 0,
            expression: "smile",
            line: "hello",
          },
        });
        assert.ok(!turn.isError, JSON.stringify(turn));
        assert.equal(
          (turn.structuredContent as { revision: number }).revision,
          1,
        );
        const tool = tools.tools.find(
          (t) => t.name === `${prefix}perform_turn`,
        )!;
        const uri = (tool._meta?.ui as { resourceUri: string }).resourceUri;
        const resource = await client.readResource({ uri });
        assert.equal(
          resource.contents[0]!.mimeType,
          "text/html;profile=mcp-app",
        );
        assert.match(
          String(
            "text" in resource.contents[0]! ? resource.contents[0].text : "",
          ),
          /角色场景/,
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await gateway.server.close();
    await upstream.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("Docker service host is opt-in and does not allow unrelated hosts or origins", async () => {
  const f = fixture();
  f.service.config.allowedHosts = ["companion"];
  const app = createHttp(f.service);
  try {
    const headers = { authorization: "Bearer test-secret" };
    assert.equal(
      (
        await app.inject({
          url: "/api/config",
          headers: { ...headers, host: "companion:4588" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/config",
          headers: { ...headers, host: "companion.evil.invalid:4588" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/config",
          headers: {
            ...headers,
            host: "companion:4588",
            origin: "https://companion",
          },
        })
      ).statusCode,
      403,
    );
    assert.throws(
      () => loadConfig({ COMPANION_ALLOWED_HOSTS: "*" }),
      /exact hostnames/,
    );
  } finally {
    await app.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
