import { writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createSavepointServer } from "../savepoint/server.js";
import { SavepointStore } from "../savepoint/store.js";

const usage = `Agent Savepoint — durable task checkpoints (Node 24+)

  node dist/cli/savepoint.js --db /persistent/savepoint.sqlite
  node dist/cli/savepoint.js --db /persistent/savepoint.sqlite --export TASK_ID --output /backup/task.json

Options:
  --db PATH       Required absolute path, or SAVEPOINT_DB_PATH
  --export ID     Export latest task and artifact bytes as portable JSON, then exit
  --revision N    Export a specific revision (requires --export)
  --output PATH   Export to a NEW file, refusing to overwrite (requires --export)
  --help          Show help

Default mode is MCP over stdio. No automatic filesystem capture or cloud backup.
Use a persistent volume. One vault per trust boundary; all connected clients can
read every task in that vault. No HTTP listener is opened.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) { console.log(usage); return; }
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!;
    if (!["--db", "--export", "--revision", "--output"].includes(key) || !argv[i + 1] || argv[i + 1]!.startsWith("--") || key in options) {
      throw new Error(`Invalid or duplicate option: ${key}\n${usage}`);
    }
    options[key] = argv[i + 1]!;
  }
  if ((options["--revision"] || options["--output"]) && !options["--export"]) throw new Error("--revision and --output require --export");
  const path = options["--db"] ?? process.env.SAVEPOINT_DB_PATH;
  if (!path) throw new Error(`Missing --db or SAVEPOINT_DB_PATH\n${usage}`);
  // Limit permissions of newly created vault files, including WAL and SHM.
  process.umask(0o077);
  const store = new SavepointStore(path);
  if (options["--export"]) {
    try {
      const data = store.export({ taskId: options["--export"], ...(options["--revision"] === undefined ? {} : { revision: Number(options["--revision"]) }) });
      const json = JSON.stringify(data, null, 2) + "\n";
      if (options["--output"]) writeFileSync(options["--output"], json, { flag: "wx", mode: 0o600 });
      else process.stdout.write(json);
    } finally { store.close(); }
    return;
  }
  const server = createSavepointServer(store);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
    store.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.stdin.once("end", () => { void close(); });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
