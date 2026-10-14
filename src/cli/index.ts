#!/usr/bin/env node
import { loadDotEnv } from "./env.js";

// Load .env before anything reads process.env (shell env still wins).
loadDotEnv();

import { runGraphScan } from "../agent/graphs/healthScanGraph.js";
import { SEVERITY_RANK, type ScanResult } from "../core/types.js";
import { formatJson, formatScan } from "./format.js";
import type { Source } from "../core/source.js";
import { FileScanStore } from "../store/fileStore.js";

interface ParsedArgs {
  command: string;
  uri?: string;
  name?: string;
  json: boolean;
  noColor: boolean;
  failOn?: "warning" | "critical";
  summarize: boolean;
  save: boolean;
  // Atlas
  atlas: boolean;
  group?: string;
  publicKey?: string;
  privateKey?: string;
  cluster?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: argv[0] ?? "help",
    json: false,
    noColor: false,
    summarize: false,
    save: false,
    atlas: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--uri":
        args.uri = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--no-color":
        args.noColor = true;
        break;
      case "--fail-on":
        args.failOn = argv[++i] as "warning" | "critical";
        break;
      case "--summarize":
        args.summarize = true;
        break;
      case "--save":
        args.save = true;
        break;
      case "--atlas":
        args.atlas = true;
        break;
      case "--group":
        args.group = argv[++i];
        break;
      case "--public":
        args.publicKey = argv[++i];
        break;
      case "--private":
        args.privateKey = argv[++i];
        break;
      case "--cluster":
        args.cluster = argv[++i];
        break;
      default:
        if (a && !a.startsWith("--") && !args.uri) args.uri = a;
    }
  }
  return args;
}

function usage(): void {
  process.stdout.write(
    [
      "ps-agent — MongoDB deployment health check",
      "",
      "Usage:",
      "  ps-agent scan --uri <connection-string> [options]   (direct)",
      "  ps-agent scan --atlas --group <id> --public <k> --private <k> [options]",
      "",
      "Options:",
      "  --uri <str>        MongoDB connection string (or set PS_AGENT_URI)",
      "  --name <str>       Friendly name for the deployment (default: host)",
      "  --json             Output machine-readable JSON",
      "  --no-color         Disable ANSI colors",
      "  --fail-on <level>  Exit non-zero if findings >= level (warning|critical)",
      "  --summarize        Run the LLM correlate/rank node (needs an API key)",
      "  --save             Persist the scan snapshot (default: ~/.ps-agent/scans)",
      "",
      "Atlas options (--atlas):",
      "  --group <id>       Atlas project (group) ID   (or GROUPID env)",
      "  --public <key>     Atlas API public key        (or PUBLICKEY env)",
      "  --private <key>    Atlas API private key       (or PRIVATEKEY env)",
      "  --cluster <name>   Limit to one cluster (optional)",
      "",
      "LLM env (for --summarize):",
      "  ANTHROPIC_API_KEY or OPENAI_API_KEY  (auto-detected)",
      "  PS_AGENT_LLM_PROVIDER=anthropic|openai   PS_AGENT_LLM_MODEL=<model>",
      "",
      "Examples:",
      '  ps-agent scan --uri "mongodb+srv://user:pass@cluster.example.net/"',
      '  PS_AGENT_URI="mongodb://localhost:27017" ps-agent scan --json',
      '  ANTHROPIC_API_KEY=... ps-agent scan --uri "..." --summarize --save',
      "",
      "Dashboard:",
      "  ps-agent serve [--port 4000]   Start the API + web dashboard",
      "",
      "Chat (needs an LLM provider configured):",
      "  ps-agent chat                  Interactive REPL over your fleet",
      "",
    ].join("\n") + "\n",
  );
}

function worstSeverity(result: ScanResult): number {
  return result.findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity]), 0);
}

async function runServe(argv: string[]): Promise<void> {
  const { createApiServer } = await import("../server/api.js");
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
  }
  const server = createApiServer({ port });
  const { host, port: p } = await server.listen();
  process.stdout.write(`ps-agent dashboard running at http://${host}:${p}\n`);
  process.stdout.write(`store backend: ${server.backend}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      // Second Ctrl+C → exit immediately.
      process.exit(130);
    }
    shuttingDown = true;
    process.stdout.write("\nShutting down…\n");
    // Hard safety net: never hang the terminal.
    const force = setTimeout(() => process.exit(130), 5000);
    force.unref();
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runChat(): Promise<void> {
  const { HealthService } = await import("../service/healthService.js");
  const readline = await import("node:readline/promises");
  const service = new HealthService();
  if (!(await service.chatAvailable())) {
    process.stderr.write(
      "No LLM provider configured. Set an API key, or " +
        "PS_AGENT_LLM_PROVIDER=ollama PS_AGENT_LLM_MODEL=<model>.\n",
    );
    process.exit(2);
  }
  const threadId = `cli-${Date.now()}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("ps-agent chat — ask about your fleet. Type 'exit' to quit.\n\n");
  for (;;) {
    let q: string;
    try {
      q = (await rl.question("you › ")).trim();
    } catch {
      break; // stdin closed (EOF / piped input) — exit cleanly
    }
    if (q === "exit" || q === "quit") break;
    if (!q) continue;
    process.stdout.write("agent › thinking…\r");
    try {
      const { reply, toolsUsed } = await service.chat(threadId, q);
      const tools = toolsUsed.length ? `  [tools: ${toolsUsed.join(", ")}]` : "";
      process.stdout.write(`agent › ${reply}${tools}\n\n`);
    } catch (err) {
      process.stdout.write(`agent › error: ${(err as Error).message}\n\n`);
    }
  }
  rl.close();
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  if (args.command === "serve") {
    await runServe(rawArgs.slice(1));
    return;
  }

  if (args.command === "chat") {
    await runChat();
    return;
  }

  if (args.command !== "scan") {
    usage();
    process.exit(args.command === "help" ? 0 : 1);
  }

  let source: Source;

  if (args.atlas) {
    const group = args.group ?? process.env.GROUPID ?? process.env.ATLAS_GROUP_ID;
    const publicKey = args.publicKey ?? process.env.PUBLICKEY ?? process.env.ATLAS_PUBLIC_KEY;
    const privateKey = args.privateKey ?? process.env.PRIVATEKEY ?? process.env.ATLAS_PRIVATE_KEY;
    if (!group || !publicKey || !privateKey) {
      process.stderr.write(
        "Error: --atlas requires --group, --public, --private " +
          "(or GROUPID/PUBLICKEY/PRIVATEKEY env vars).\n\n",
      );
      usage();
      process.exit(2);
    }
    source = {
      id: "cli-source",
      name: args.name ?? args.cluster ?? "atlas-project",
      kind: "atlas",
      atlas: { projectId: group, publicKey, privateKey, clusterName: args.cluster },
    };
  } else {
    const uri = args.uri ?? process.env.PS_AGENT_URI;
    if (!uri) {
      process.stderr.write(
        "Error: no connection string. Pass --uri or set PS_AGENT_URI (or use --atlas).\n\n",
      );
      usage();
      process.exit(2);
    }
    source = {
      id: "cli-source",
      name: args.name ?? "deployment",
      kind: "direct",
      connectionString: uri,
    };
  }

  let result: ScanResult;
  try {
    result = await runGraphScan(source, {
      summarize: args.summarize,
      store: args.save ? new FileScanStore() : undefined,
    });
  } catch (err) {
    process.stderr.write(`Scan failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const useColor = !args.noColor && process.stdout.isTTY === true;
  process.stdout.write(args.json ? formatJson(result) + "\n" : formatScan(result, useColor));

  if (args.failOn) {
    const threshold = args.failOn === "critical" ? SEVERITY_RANK.critical : SEVERITY_RANK.warning;
    if (worstSeverity(result) >= threshold) process.exit(3);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
