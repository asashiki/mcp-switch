import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

// Serves the standalone console SPA (Cowork-built, vite base "/console/") from
// a local dist directory. Hand-rolled instead of @fastify/static to keep the
// gateway dependency-thin: three assets + an index.html fallback don't justify
// a plugin. The old server-rendered console lives on at /console-legacy.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

export function registerConsoleSpa(server: FastifyInstance, distDir: string): boolean {
  const root = resolve(distDir);
  if (!existsSync(join(root, "index.html"))) return false;

  const sendIndex = async (reply: { type: (t: string) => unknown; send: (b: Buffer) => unknown }) => {
    reply.type(MIME[".html"]!);
    return reply.send(await readFile(join(root, "index.html")));
  };

  server.get("/console", async (_request, reply) => reply.redirect("/console/"));
  server.get("/console/", async (_request, reply) => sendIndex(reply));
  server.get("/console/*", async (request, reply) => {
    const rel = (request.params as { "*": string })["*"] ?? "";
    const file = join(root, rel);
    // Path traversal guard + only real files; anything else is an SPA route.
    if (rel && !rel.includes("..") && file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
      reply.type(MIME[extname(file)] ?? "application/octet-stream");
      if (rel.startsWith("assets/")) {
        // Vite emits content-hashed asset names; safe to cache hard.
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      }
      return reply.send(await readFile(file));
    }
    return sendIndex(reply);
  });
  return true;
}
