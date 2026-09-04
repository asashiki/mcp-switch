import { readFileSync } from "node:fs";
import { inspectRemoteGateway, type RemoteGatewayCheckReport } from "./remote-check-lib.js";

type CliOptions = {
  endpoint: string;
  token?: string;
  timeoutMs: number;
  runLegacy: boolean;
  json: boolean;
  allowPartial: boolean;
};

function usage(): string {
  return `MCP Switch remote canary check

Usage:
  pnpm check:remote -- --url https://mcp-canary.example.com
  MCP_CHECK_TOKEN=... pnpm check:remote -- --url https://mcp-canary.example.com
  pnpm check:remote -- --url https://mcp-canary.example.com/mcp --token-file /secure/token

Options:
  --url <url>          Public base URL or exact /mcp endpoint (also MCP_CHECK_URL)
  --token-file <path>  Read a Bearer token from a file; never prints it
  --token-env <name>   Read token from this environment variable (default MCP_CHECK_TOKEN)
  --timeout <ms>       Per-request timeout (default 15000)
  --modern-only        Skip the MCP 2025 compatibility connection
  --allow-partial      Exit 0 when OAuth checks pass but no token was supplied
  --json               Emit the full machine-readable report
  --help               Show this help

The checker never invokes tools. It reads only health/OAuth metadata, catalogs,
and UI resources linked by tool metadata.`;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  let endpoint = env.MCP_CHECK_URL ?? "";
  let tokenEnv = "MCP_CHECK_TOKEN";
  let tokenFile: string | undefined;
  let timeoutMs = 15_000;
  let runLegacy = true;
  let json = false;
  let allowPartial = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--url") endpoint = next();
    else if (arg === "--token-file") tokenFile = next();
    else if (arg === "--token-env") tokenEnv = next();
    else if (arg === "--timeout") timeoutMs = Number(next());
    else if (arg === "--modern-only") runLegacy = false;
    else if (arg === "--json") json = true;
    else if (arg === "--allow-partial") allowPartial = true;
    else if (!arg.startsWith("-") && !endpoint) endpoint = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!endpoint) throw new Error("Missing --url (or MCP_CHECK_URL)");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("--timeout must be between 1000 and 120000 milliseconds");
  }
  const token = tokenFile
    ? readFileSync(tokenFile, "utf8").trim()
    : env[tokenEnv]?.trim();
  return { endpoint, token: token || undefined, timeoutMs, runLegacy, json, allowPartial };
}

function printHuman(report: RemoteGatewayCheckReport): void {
  const badge = report.status.toUpperCase();
  console.log(`[${badge}] ${report.endpoint}`);
  if (report.modern) {
    console.log(`  modern: ${report.modern.protocolVersion ?? "unknown"}, ${report.modern.toolNames.length} tools, ${report.modern.appResources.length} apps`);
  }
  if (report.legacy) {
    console.log(`  legacy: ${report.legacy.protocolVersion ?? "unknown"}, ${report.legacy.toolNames.length} tools, ${report.legacy.appResources.length} apps`);
  }
  for (const finding of report.findings) {
    const marker = finding.level === "pass" ? "✓" : finding.level === "fail" ? "✗" : finding.level === "skip" ? "○" : "!";
    console.log(`  ${marker} ${finding.message}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2), process.env);
  const report = await inspectRemoteGateway({
    endpoint: options.endpoint,
    bearerToken: options.token,
    timeoutMs: options.timeoutMs,
    runLegacy: options.runLegacy
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);

  if (report.status === "fail") process.exitCode = 1;
  else if (report.status === "partial" && !options.allowPartial) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("\n" + usage());
  process.exitCode = 1;
}
