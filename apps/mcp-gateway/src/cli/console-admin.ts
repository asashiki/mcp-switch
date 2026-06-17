/**
 * Console admin account management.
 *
 *   tsx src/cli/console-admin.ts set <username> [password]   # create/reset (random pw if omitted)
 *   tsx src/cli/console-admin.ts list
 *
 * DB path from MCP_AUTH_DB_PATH (default ./data/mcp-auth.sqlite).
 */
import { randomBytes } from "node:crypto";
import { AuthStore } from "../auth/store.js";

const DB_PATH = process.env.MCP_AUTH_DB_PATH ?? "./data/mcp-auth.sqlite";

async function main() {
  const [cmd, username, password] = process.argv.slice(2);
  const store = new AuthStore(DB_PATH);
  try {
    switch (cmd) {
      case "set": {
        if (!username) { console.error("usage: set <username> [password]"); process.exit(1); }
        const pw = password ?? randomBytes(12).toString("base64url");
        store.setConsoleAdmin(username, pw);
        console.log(`\n  ✅ console admin: ${username}`);
        if (!password) console.log(`     password (随机生成，请保存): ${pw}`);
        else console.log(`     password 已设置。`);
        break;
      }
      case "list":
      default: {
        const admins = store.listConsoleAdmins();
        console.log(admins.length ? admins.join("\n") : "(no console admins — run `set <username>`)");
        break;
      }
    }
  } finally {
    store.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
