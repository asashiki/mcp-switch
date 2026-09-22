import { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { Companion } from "./service.js";
import { id } from "./config.js";

export const UI_URI = "ui://companion/stage-v2.html";
const uuid = z.string().uuid(),
  event = z.string().min(1).max(120),
  revision = z.number().int().nonnegative();
export function createServer(service: Companion, owner = "personal") {
  const server = new McpServer(
    { name: "companion-mcp", version: "0.1.0" },
    {
      instructions:
        "Use only when the user enables companion mode. Call list_companions then open_companion. Avatar mode preserves your current personality; role mode returns the chosen persona. React as the companion, not by mirroring user emotion. Use perform_turn only when a visual response helps. Preserve scene/outfit unless the conversation changes them. This service does not listen to chat history. Never claim a generation completed until job status is succeeded.",
    },
  );
  const meta = { ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI };
  const csp = {
    ui: {
      prefersBorder: false,
      csp: {
        resourceDomains: [service.config.publicUrl],
        connectDomains: [service.config.publicUrl],
      },
    },
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": {
      resource_domains: [service.config.publicUrl],
      connect_domains: [service.config.publicUrl],
    },
  };
  registerAppResource(server, "companion-stage", UI_URI, {}, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: "text/html;profile=mcp-app",
        text: readFileSync(
          new URL("../dist/stage.html", import.meta.url),
          "utf8",
        ),
        _meta: csp,
      },
    ],
  }));
  const text = (data: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const guard = <T>(
    fn: () => T,
  ): T | { isError: true; content: Array<{ type: "text"; text: string }> } => {
    try {
      return fn();
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: e instanceof Error ? e.message : "Operation failed",
          },
        ],
      };
    }
  };
  server.registerTool(
    "list_companions",
    {
      description:
        "List configured companion identities and available expressions, scenes and outfits. Use before opening a companion.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text({ characters: service.catalog() }),
  );
  registerAppTool(
    server,
    "open_companion",
    {
      description:
        "Start a companion session after the user opts in. Use a fresh random UUID event_id for each new conversation; reuse it only on retries. avatar adds an appearance only; role explicitly adopts the saved persona. Keep the returned sessionId for this conversation; never invent or reuse another conversation session.",
      inputSchema: z.object({
        character_id: id,
        mode: z.enum(["avatar", "role"]).default("avatar"),
        event_id: uuid,
      }),
      _meta: meta,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ character_id, mode, event_id }) =>
      guard(() => {
        const s = service.store.open(
          owner,
          event_id,
          service.character(character_id),
          mode,
        );
        const result = service.sceneResult(s);
        return {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            catalog: service.catalog().find((c) => c.id === character_id),
            ...(mode === "role" ? { persona: s.character.persona } : {}),
          },
        };
      }),
  );
  registerAppTool(
    server,
    "perform_turn",
    {
      description:
        "Show your own reaction, expression and short line in the companion scene. Use once per meaningful visual response. Omitted scene/outfit/action persist. line must agree with your reply. Use catalog IDs, current expected_revision and a new event_id (reuse exactly on retry). Does not generate images or spend credits.",
      inputSchema: z.object({
        session_id: uuid,
        event_id: event,
        expected_revision: revision,
        expression: id.optional(),
        scene_id: id.optional(),
        outfit: id.optional(),
        action: z.string().max(600).optional(),
        line: z.string().max(2000),
      }),
      _meta: meta,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (a) =>
      guard(() =>
        service.sceneResult(
          service.store.perform(owner, {
            sessionId: a.session_id,
            eventId: a.event_id,
            expectedRevision: a.expected_revision,
            expression: a.expression,
            sceneId: a.scene_id,
            outfit: a.outfit,
            action: a.action,
            line: a.line,
          }),
        ),
      ),
  );
  registerAppTool(
    server,
    "get_scene",
    {
      description:
        "Restore this conversation scene or read an immutable historical revision. Refreshes expiring media links.",
      inputSchema: z.object({
        session_id: uuid,
        revision: revision.optional(),
      }),
      _meta: meta,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) =>
      guard(() =>
        service.sceneResult(
          service.store.scene(owner, a.session_id, a.revision),
        ),
      ),
  );
  registerAppTool(
    server,
    "request_illustration",
    {
      description:
        "Prepare or generate one CG of a saved scene. generate=false previews prompts without cost. Set generate=true only for a user-initiated illustration request, subject to the operator daily cap. composition adds framing/light only; character, style, outfit and expressions are supplied by saved configuration. Do not send private conversation history. Async job; retry with identical event_id and arguments, never automatically retry failed jobs.",
      inputSchema: z.object({
        session_id: uuid,
        revision,
        event_id: event,
        composition: z.string().max(1000),
        seed: z.number().int().min(0).max(4294967295).optional(),
        generate: z.boolean().default(false),
      }),
      _meta: meta,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) =>
      guard(() =>
        text(
          service.request(owner, {
            sessionId: a.session_id,
            revision: a.revision,
            eventId: a.event_id,
            composition: a.composition,
            seed: a.seed,
            generate: a.generate,
          }),
        ),
      ),
  );
  registerAppTool(
    server,
    "get_illustration",
    {
      description:
        "Read a CG job and its original scene. Does not alter the current scene. When succeeded the widget shows the CG; otherwise report pending or failed honestly.",
      inputSchema: z.object({ job_id: uuid }),
      _meta: meta,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) =>
      guard(() => {
        const job = service.store.job(owner, a.job_id);
        return service.illustrationResult(owner, job);
      }),
  );
  return server;
}
