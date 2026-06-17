import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serviceKindSchema } from "@mcp-switch/schemas";
import { z } from "zod";

const serviceEnvBaseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive()
});

let envLoaded = false;

function loadWorkspaceEnv(cwd = process.cwd()) {
  if (envLoaded) {
    return;
  }

  const candidates = [
    resolve(cwd, ".env.local"),
    resolve(cwd, ".env"),
    resolve(cwd, "../../.env.local"),
    resolve(cwd, "../../.env")
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
    }
  }

  envLoaded = true;
}

export function parseServiceEnv<TShape extends z.ZodRawShape>(
  app: z.infer<typeof serviceKindSchema>,
  source: NodeJS.ProcessEnv,
  shape: TShape
) {
  loadWorkspaceEnv();
  serviceKindSchema.parse(app);

  return serviceEnvBaseSchema.extend(shape).parse(source);
}

export function getOptionalString(
  source: Record<string, string | undefined>,
  key: string,
  fallback: string
) {
  const value = source[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function getOptionalEnvValue(
  source: Record<string, string | undefined>,
  key: string
) {
  const value = source[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}
