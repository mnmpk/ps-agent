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
      "Offline (isolated clusters):",
      "  ps-agent import --dir <folder> [--name <n>] [--source <id>] [--json]",
      "    Import a WHOLE FOLDER of diagnostics at once — any mix of getMongoData,",
      "    mdiag, and FTDC files across multiple nodes. Each file is auto-detected by",
      "    content and ingested into a single deployment. This is the easiest path.",
      "  ps-agent import --file getMongoData.log [--name <n>] [--json]",
      "    Import a MongoDB getMongoData.js export (no connection needed).",
      "    (A directory given to --file without a type flag is treated like --dir.)",
      "  ps-agent import --mdiag --file mdiag.json [--source <id>]",
      "    Import an mdiag.sh OS report (adds swappiness/THP/ulimit/SELinux risks);",
      "    --source attaches OS facts to an existing deployment.",
      "  ps-agent import --ftdc --file <diagnostic.data | metrics.* | dir1,dir2> [--source <id>]",
      "    Import MongoDB FTDC diagnostic data for OFFLINE capacity metrics",
      "    (CPU/memory/disk/IOPS trends). --file may be a diagnostic.data directory,",
      "    a single metrics.* file, or several comma-separated paths (one per node).",
      "    Files are read in place and streamed one at a time (bounded memory); the",
      "    raw GBs are NOT copied into the store — only the extracted series are kept.",
      "    --source attaches the metrics to an existing deployment.",
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

async function runImport(argv: string[]): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { HealthService } = await import("../service/healthService.js");
  let file: string | undefined;
  let dir: string | undefined;
  let name: string | undefined;
  let sourceId: string | undefined;
  let mdiag = false;
  let ftdc = false;
  let json = false;
  let noColor = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") file = argv[++i];
    else if (argv[i] === "--dir") dir = argv[++i];
    else if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--source") sourceId = argv[++i];
    else if (argv[i] === "--mdiag") mdiag = true;
    else if (argv[i] === "--ftdc") ftdc = true;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--no-color") noColor = true;
    else if (argv[i] && !argv[i]!.startsWith("--") && !file) file = argv[i];
  }

  // Unified bundle import: point at a folder (or a single file is auto-routed
  // when no explicit type flag is given). Auto-detects getMongoData / mdiag /
  // FTDC and ingests everything into one cluster source.
  const bundleTarget = dir ?? (!mdiag && !ftdc && file && (await isDirectory(file)) ? file : undefined);
  if (bundleTarget) {
    try {
      const paths = await collectFiles(bundleTarget);
      if (paths.length === 0) {
        process.stderr.write(`No files found under ${bundleTarget}\n`);
        process.exit(1);
      }
      const svc = new HealthService();
      const { basename } = await import("node:path");
      const result = await svc.importBundle(
        paths.map((p) => ({ filename: basename(p), path: p })),
        { name, sourceId },
      );
      process.stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : formatBundle(result));
    } catch (err) {
      process.stderr.write(`Import failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  if (!file) {
    process.stderr.write("Error: provide --dir <folder> (auto-detect), or --file <getMongoData.log | mdiag.json | diagnostic.data | metrics.*>\n");
    process.exit(2);
  }

  // FTDC is binary and may be a directory (diagnostic.data), a single metrics.*
  // file, or several comma-separated paths (e.g. one diagnostic.data per node).
  // Files are streamed from disk one at a time — the raw GBs are never loaded in
  // bulk nor copied into the store; only the extracted series are kept.
  if (ftdc) {
    let paths: string[];
    try {
      paths = await resolveFtdcPaths(file);
    } catch (err) {
      process.stderr.write(`Cannot read FTDC from ${file}: ${(err as Error).message}\n`);
      process.exit(1);
    }
    if (paths.length === 0) {
      process.stderr.write(`No FTDC metrics.* files found at ${file}\n`);
      process.exit(1);
    }
    try {
      const svc = new HealthService();
      const scan = await svc.importFtdcFiles(paths, { name, sourceId, input: file });
      const useColor = !noColor && process.stdout.isTTY === true;
      process.stdout.write(json ? formatJson(scan) + "\n" : formatScan(scan, useColor));
      if (!json) {
        process.stdout.write(
          `\nFTDC: ${scan.filesProcessed} file(s), ${scan.nodes.length} node(s), ` +
            `${scan.seriesCount} series, ${scan.metricPointsAdded} points ingested for capacity analysis.\n` +
            `(raw FTDC files were read in place and not copied into the agent store)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`Import failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    process.stderr.write(`Cannot read ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  try {
    const svc = new HealthService();
    const scan = mdiag
      ? await svc.importMdiag(raw, { name, sourceId })
      : await svc.importGetMongoData(raw, { name, sourceId });
    const useColor = !noColor && process.stdout.isTTY === true;
    process.stdout.write(json ? formatJson(scan) + "\n" : formatScan(scan, useColor));
  } catch (err) {
    process.stderr.write(`Import failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * Resolve FTDC input into a list of file PATHS (not bytes — they're streamed
 * later). Each input may be a single `metrics.*` file or a `diagnostic.data`
 * directory (every `metrics.*` except the live `metrics.interim`, oldest first).
 * Multiple inputs — e.g. one diagnostic.data per node — may be comma-separated.
 */
async function resolveFtdcPaths(input: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const inputs = input.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const path of inputs) {
    const st = await stat(path);
    if (st.isDirectory()) {
      const names = (await readdir(path))
        .filter((n) => n.startsWith("metrics.") && n !== "metrics.interim")
        .sort();
      for (const n of names) out.push(join(path, n));
    } else {
      out.push(path);
    }
  }
  return out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively collect candidate diagnostic file paths under a directory. Skips
 * obvious non-diagnostic noise (WiredTiger/journal/lock files, hidden files)
 * so pointing at a folder that happens to contain a raw dbpath doesn't flood the
 * import with unrecognized files. metrics.* (FTDC) and *.json/*.log are kept.
 */
async function collectFiles(root: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out: string[] = [];
  const st = await stat(root);
  if (!st.isDirectory()) return [root];
  const skipFile = (n: string): boolean =>
    n.startsWith(".") ||
    n === "metrics.interim" ||
    /\.(wt|lock|turtle)$/.test(n) ||
    /^WiredTiger/.test(n) ||
    /^(mongod\.lock|storage\.bson|sizeStorer|_mdb_catalog)/.test(n) ||
    /^journal$/.test(n);
  const skipDir = (n: string): boolean => n === "journal" || n === "_tmp" || n.startsWith(".");
  const walk = async (d: string): Promise<void> => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!skipDir(ent.name)) await walk(join(d, ent.name));
      } else if (!skipFile(ent.name)) {
        out.push(join(d, ent.name));
      }
    }
  };
  await walk(root);
  return out.sort();
}

function formatBundle(r: {
  sourceName: string;
  score: number;
  counts: { getMongoData: number; mdiag: number; ftdc: number; unknown: number };
  nodes: string[];
  metricPointsAdded: number;
  seriesCount: number;
  perFile: Array<{ filename: string; kind: string }>;
  warnings: string[];
}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Imported into deployment: ${r.sourceName}   (health ${r.score}/100)`);
  lines.push(
    `  Files: ${r.counts.getMongoData} getMongoData · ${r.counts.mdiag} mdiag · ` +
      `${r.counts.ftdc} FTDC` + (r.counts.unknown ? ` · ${r.counts.unknown} unrecognized` : ""),
  );
  if (r.nodes.length) lines.push(`  Nodes: ${r.nodes.join(", ")}`);
  if (r.seriesCount) lines.push(`  FTDC: ${r.seriesCount} series, ${r.metricPointsAdded} points ingested`);
  for (const w of r.warnings) lines.push(`  ! ${w}`);
  lines.push("");
  return lines.join("\n");
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

  if (args.command === "import") {
    await runImport(rawArgs.slice(1));
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
