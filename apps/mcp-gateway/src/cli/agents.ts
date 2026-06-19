/**
 * Agent management CLI for the MCP Switch OAuth layer.
 *
 *   tsx src/cli/agents.ts seed                 # create the minimal agent set
 *   tsx src/cli/agents.ts list
 *   tsx src/cli/agents.ts add <agent_id> <display_name>
 *   tsx src/cli/agents.ts regen <agent_id>     # rotate secret (prints once)
 *   tsx src/cli/agents.ts enable <agent_id>
 *   tsx src/cli/agents.ts disable <agent_id>
 *
 * DB path comes from MCP_AUTH_DB_PATH (default ./data/mcp-auth.sqlite).
 */
import { AuthStore } from "../auth/store.js";

const DB_PATH = process.env.MCP_AUTH_DB_PATH ?? "./data/mcp-auth.sqlite";

const MINIMAL_AGENTS: { agentId: string; displayName: string }[] = [
  { agentId: "claude-ai", displayName: "Claude.ai" },
  { agentId: "chatgpt-ai", displayName: "ChatGPT" },
  { agentId: "manual-test", displayName: "Manual Test" }
];

function printSecret(agentId: string, secret: string | null) {
  if (secret) {
    console.log(`\n  ✅ ${agentId}`);
    console.log(`     secret (shown once — save it now): ${secret}`);
  } else {
    console.log(`  ↻ ${agentId} already exists, unchanged (use regen to rotate the secret)`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new AuthStore(DB_PATH);

  try {
    switch (cmd) {
      case "seed": {
        console.log("Seeding minimal agent set...");
        for (const a of MINIMAL_AGENTS) {
          const res = store.upsertAgent(a.agentId, a.displayName);
          printSecret(a.agentId, res.secret);
        }
        console.log("\nSecrets are shown only once. Enter the matching secret on the consent page when authorizing.");
        break;
      }
      case "add": {
        const [agentId, ...nameParts] = args;
        if (!agentId) { console.error("usage: add <agent_id> <display_name>"); process.exit(1); }
        const displayName = nameParts.join(" ") || agentId;
        const res = store.upsertAgent(agentId, displayName);
        printSecret(agentId, res.secret);
        break;
      }
      case "regen": {
        const [agentId] = args;
        if (!agentId) { console.error("usage: regen <agent_id>"); process.exit(1); }
        const secret = store.regenerateSecret(agentId);
        if (!secret) { console.error(`agent not found: ${agentId}`); process.exit(1); }
        console.log(`\n  ✅ ${agentId} new secret (shown once): ${secret}`);
        break;
      }
      case "enable":
      case "disable": {
        const [agentId] = args;
        if (!agentId) { console.error(`usage: ${cmd} <agent_id>`); process.exit(1); }
        const ok = store.setAgentEnabled(agentId, cmd === "enable");
        if (!ok) { console.error(`agent not found: ${agentId}`); process.exit(1); }
        console.log(`${agentId} -> ${cmd === "enable" ? "enabled" : "disabled (tokens revoked)"}`);
        break;
      }
      case "list":
      default: {
        const agents = store.listAgents();
        if (agents.length === 0) { console.log("(no agents — run `seed`)"); break; }
        console.log("agent_id            display_name        enabled  last_used");
        for (const a of agents) {
          console.log(
            `${a.agentId.padEnd(20)}${a.displayName.padEnd(20)}${(a.enabled ? "yes" : "no").padEnd(9)}${a.lastUsedAt ?? "-"}`
          );
        }
        break;
      }
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
