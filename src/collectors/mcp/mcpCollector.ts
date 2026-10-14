import type { Collector } from "../collector.js";
import type { Source } from "../../core/source.js";
import type { CollectedFacts, StorageFacts, Topology } from "../../core/types.js";
import { DirectCollector } from "../direct/directCollector.js";

/**
 * Collects facts for an MCP-registered source.
 *
 * Policy (per product requirement): prefer the DEEPEST check possible.
 *  - If the source also has a connection string, run the full DirectCollector
 *    (node-level: serverStatus, replSetGetStatus, index usage) AND enrich with
 *    data-layer facts from the MCP server (db-stats → disk/storage usage).
 *    collectionMethod = "mcp+direct".
 *  - If no connection string, fall back to MCP-only data-layer facts
 *    (db-stats, list-databases). Node-level checks are unavailable; a warning
 *    explains this. collectionMethod = "mcp".
 *
 * The MongoDB MCP server exposes data tools (find, aggregate, db-stats,
 * list-databases, collection-indexes) but no raw-command tool, so node-level
 * metrics genuinely require the driver.
 */
export class McpCollector implements Collector {
  private client: any;
  private transport: any;
  private direct?: DirectCollector;
  /** connectionId required by MongoDB MCP data tools. */
  private connectionId = "preconfigured";

  constructor(private readonly source: Source) {
    if (!source.mcp) throw new Error(`Source ${source.id} is not an MCP source`);
  }

  async collect(): Promise<CollectedFacts> {
    const warnings: string[] = [];

    // 1. Deep node-level check via the driver when a connection string exists.
    let base: CollectedFacts | undefined;
    if (this.source.connectionString) {
      try {
        this.direct = new DirectCollector(this.source);
        base = await this.direct.collect();
      } catch (err) {
        warnings.push(`Direct (deep) collection failed: ${(err as Error).message}`);
      }
    } else {
      warnings.push(
        "No connection string on this MCP source; node-level checks " +
          "(replication, tickets, cache, CPU) are unavailable. Add a connectionString for a deep scan.",
      );
    }

    // 2. Enrich with data-layer facts from the MCP server.
    let storage: StorageFacts | undefined;
    try {
      storage = await this.collectStorageViaMcp(warnings);
    } catch (err) {
      warnings.push(`MCP enrichment failed: ${(err as Error).message}`);
    }

    const method: CollectedFacts["collectionMethod"] = base ? "mcp+direct" : "mcp";

    if (base) {
      return {
        ...base,
        storage: storage ?? base.storage,
        collectionMethod: method,
        warnings: [...base.warnings, ...warnings],
      };
    }

    // MCP-only facts (no deep check available).
    const topology: Topology = {
      type: "standalone",
      mongoVersion: "unknown",
      nodeCount: 1,
    };
    return {
      sourceId: this.source.id,
      sourceName: this.source.name,
      collectedAt: new Date(),
      topology,
      storage,
      collectionMethod: method,
      warnings,
    };
  }

  async close(): Promise<void> {
    try {
      await this.direct?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.client?.close?.();
    } catch {
      /* ignore */
    }
    try {
      await this.transport?.close?.();
    } catch {
      /* ignore */
    }
  }

  // --- MCP enrichment ------------------------------------------------------

  private async collectStorageViaMcp(warnings: string[]): Promise<StorageFacts | undefined> {
    const { Client } = await importMcp("@modelcontextprotocol/sdk/client/index.js");
    this.client = new Client({ name: "ps-agent", version: "0.1.0" });
    this.transport = await this.buildTransport();
    await this.client.connect(this.transport);

    const tools = (await this.client.listTools())?.tools ?? [];
    const names = new Set<string>(tools.map((t: { name: string }) => t.name));

    if (!names.has("list-databases") && !names.has("db-stats")) {
      warnings.push(
        "MCP server exposes no db-stats/list-databases tools; skipping data-layer enrichment.",
      );
      return undefined;
    }

    // MongoDB MCP data tools require a connectionId. Establish one via the
    // `connect` tool using our connection string; fall back to "preconfigured"
    // (works when the server was launched with MDB_MCP_CONNECTION_STRING).
    if (names.has("connect") && this.source.connectionString) {
      try {
        const res = await this.client.callTool({
          name: "connect",
          arguments: { connectionString: this.source.connectionString },
        });
        const text = textOf(res);
        const m = text?.match(/connectionId is "([^"]+)"/);
        if (m) this.connectionId = m[1]!;
      } catch (err) {
        warnings.push(`MCP connect failed, using preconfigured: ${(err as Error).message}`);
      }
    }

    // Per-database stats roll-up.
    const dbNames = await this.listDatabases(names, warnings);
    const perDb: NonNullable<StorageFacts["databases"]> = [];
    let dataSize = 0;
    let indexSize = 0;
    let fsUsed: number | undefined;
    let fsTotal: number | undefined;

    for (const db of dbNames) {
      const stats = await this.dbStats(db, warnings);
      if (!stats) continue;
      const ds = num(stats.dataSize);
      const is = num(stats.indexSize);
      dataSize += ds;
      indexSize += is;
      // fsUsed/fsTotal are instance-wide; capture once.
      if (fsUsed == null && stats.fsUsedSize != null) fsUsed = num(stats.fsUsedSize);
      if (fsTotal == null && stats.fsTotalSize != null) fsTotal = num(stats.fsTotalSize);
      perDb.push({
        name: db,
        dataSize: ds,
        indexSize: is,
        collections: num(stats.collections),
      });
    }

    if (perDb.length === 0 && fsUsed == null) return undefined;
    return {
      fsUsedBytes: fsUsed,
      fsTotalBytes: fsTotal,
      dataSizeBytes: dataSize,
      indexSizeBytes: indexSize,
      databases: perDb,
    };
  }

  private async listDatabases(
    names: Set<string>,
    warnings: string[],
  ): Promise<string[]> {
    if (!names.has("list-databases")) return [];
    try {
      const res = await this.client.callTool({
        name: "list-databases",
        arguments: { connectionId: this.connectionId },
      });
      const json = extractJson(res);
      const dbs: Array<{ name: string }> = json?.databases ?? [];
      const skip = new Set(["admin", "local", "config"]);
      return dbs.map((d) => d.name).filter((n) => n && !skip.has(n));
    } catch (err) {
      warnings.push(`MCP list-databases failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async dbStats(
    database: string,
    warnings: string[],
  ): Promise<Record<string, any> | undefined> {
    try {
      const res = await this.client.callTool({
        name: "db-stats",
        arguments: { connectionId: this.connectionId, database },
      });
      const json = extractJson(res);
      // db-stats wraps results as { database, stats: {...} } or returns stats directly.
      return json?.stats ?? json ?? undefined;
    } catch (err) {
      if (!warnings.some((w) => w.startsWith("MCP db-stats failed"))) {
        warnings.push(`MCP db-stats failed: ${(err as Error).message}`);
      }
      return undefined;
    }
  }

  private async buildTransport(): Promise<any> {
    const mcp = this.source.mcp!;
    if (mcp.transport === "stdio") {
      if (!mcp.command) throw new Error("MCP stdio source requires a command");
      const { StdioClientTransport } = await importMcp(
        "@modelcontextprotocol/sdk/client/stdio.js",
      );
      const [command, ...args] = mcp.command.split(" ");
      // Pass the connection string to the MCP server if it needs one.
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (this.source.connectionString) {
        env.MDB_MCP_CONNECTION_STRING = this.source.connectionString;
      }
      return new StdioClientTransport({ command, args, env });
    }
    if (!mcp.url) throw new Error("MCP http source requires a url");
    const { StreamableHTTPClientTransport } = await importMcp(
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
    );
    return new StreamableHTTPClientTransport(new URL(mcp.url));
  }
}

// --- helpers ---------------------------------------------------------------

async function importMcp(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`MCP SDK not installed. Run: npm install @modelcontextprotocol/sdk`);
  }
}

/** First text block of an MCP tool result, if any. */
function textOf(res: any): string | undefined {
  const content = res?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b: any) => b?.type === "text" && typeof b.text === "string");
  return block?.text;
}

/**
 * Extract structured JSON from an MCP tool result. The MongoDB MCP server
 * returns parsed data in `structuredContent` (the text blocks are prose wrapped
 * in untrusted-data guards). We prefer structuredContent, then fall back to
 * parsing a JSON body out of a text block.
 */
function extractJson(res: any): Record<string, any> | undefined {
  if (res?.structuredContent && typeof res.structuredContent === "object") {
    return res.structuredContent as Record<string, any>;
  }
  const content = res?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const text: string = block.text;
    for (const start of [0, text.indexOf("{"), text.indexOf("[")]) {
      if (start < 0) continue;
      try {
        return JSON.parse(text.slice(start)) as Record<string, any>;
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

/** MongoDB extended-JSON numbers may be { $numberLong: "n" }; coerce to number. */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "$numberLong" in (v as any)) {
    return Number((v as any).$numberLong);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
