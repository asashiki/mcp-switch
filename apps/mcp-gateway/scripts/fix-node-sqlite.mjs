import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// tsup may emit chunk-*.js files when there are dynamic imports. Rewrite
// every JS file in dist/, not just server.js, so a stray `await import()`
// elsewhere doesn't leave a chunk with `from "sqlite"` that Node can't
// resolve at runtime.
const distDir = resolve(process.cwd(), "dist");
const files = (await readdir(distDir)).filter((name) => name.endsWith(".js"));

let touched = 0;
for (const name of files) {
  const fullPath = resolve(distDir, name);
  const source = await readFile(fullPath, "utf8");
  const next = source
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'");

  if (next !== source) {
    await writeFile(fullPath, next, "utf8");
    console.log(`Rewrote sqlite import in dist/${name}.`);
    touched += 1;
  }
}

if (touched === 0) {
  console.log("No sqlite import rewrite needed.");
}
