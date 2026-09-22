import { z } from "zod";

const text = z.string().max(16_000);
const lines = z.array(z.string().min(1).max(2_000)).max(64);
const requestId = z.string().min(1).max(128);
export const taskId = z.string().uuid();
export const artifactPath = z.string().min(1).max(240).refine((value) =>
  !/[\\:\x00-\x1f\x7f]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Use a relative POSIX path without empty, dot, parent, drive or control segments");
export const createSchema = z.strictObject({
  requestId,
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(16_000)
});
export const checkpointSchema = z.strictObject({
  taskId,
  requestId,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  summary: text,
  nextSteps: lines,
  decisions: lines.default([]),
  constraints: lines.default([]),
  status: z.enum(["active", "blocked", "done"]).default("active"),
  artifacts: z.array(z.strictObject({
    path: artifactPath,
    encoding: z.enum(["utf8", "base64"]),
    content: z.string().max(700_000)
  })).max(32).default([]),
  removePaths: z.array(artifactPath).max(32).default([])
});
export const resumeSchema = z.strictObject({ taskId, revision: z.number().int().min(0).optional() });
export const readSchema = z.strictObject({ taskId, revision: z.number().int().min(1), path: artifactPath });
export const listSchema = z.strictObject({
  after: taskId.optional(), limit: z.number().int().min(1).max(100).default(20)
});
export const handoffSchema = z.strictObject({
  taskId, revision: z.number().int().min(0).optional(),
  target: z.string().min(1).max(200), assignment: z.string().min(1).max(8_000)
});
