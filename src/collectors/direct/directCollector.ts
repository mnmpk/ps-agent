import { MongoClient, type Db } from "mongodb";
import type { Collector } from "../collector.js";
import type { Source } from "../../core/source.js";
import type {
  CollectedFacts,
  ConnectionStats,
  HostInfo,
  IndexUsage,
  OpCounters,
  ReplMember,
  ReplSetStatus,
  ServerStatus,
  StorageFacts,
  Topology,
  WiredTigerCache,
} from "../../core/types.js";

/**
 * Collects facts from any MongoDB reachable by a connection string.
 *
 * Required privileges: the `clusterMonitor` built-in role is sufficient for
 * serverStatus / replSetGetStatus / $indexStats. Missing privileges are
 * downgraded to `warnings` rather than failing the whole scan.
 */
export class DirectCollector implements Collector {
  private client: MongoClient;
  private readonly source: Source;

  constructor(source: Source) {
    if (!source.connectionString) {
      throw new Error(`Source ${source.id} has no connectionString`);
    }
    this.source = source;
    this.client = new MongoClient(source.connectionString, {
      // Short, explicit timeouts: a monitoring tool must never hang.
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      // Read-only monitoring workload; keep the pool tiny.
      maxPoolSize: 4,
      appName: "ps-agent-health",
    });
  }

  async collect(): Promise<CollectedFacts> {
    const warnings: string[] = [];
    await this.client.connect();
    const admin = this.client.db("admin");

    const serverStatusRaw = await admin.command({ serverStatus: 1 });
    const cmdLineOpts = await this.safeCommand(
      admin,
      { getCmdLineOpts: 1 },
      warnings,
      "getCmdLineOpts (security info unavailable without privilege)",
    );

    const serverStatus = this.parseServerStatus(serverStatusRaw, cmdLineOpts);

    let replSetStatus: ReplSetStatus | undefined;
    const replRaw = await this.safeCommand(
      admin,
      { replSetGetStatus: 1 },
      warnings,
      undefined, // standalone will error here; that's expected, not a warning
      /* silent */ true,
    );
    if (replRaw) {
      replSetStatus = this.parseReplSetStatus(replRaw);
    }

    const topology = this.deriveTopology(serverStatus, replSetStatus);

    const indexUsage = await this.collectIndexUsage(warnings);
    const storage = await this.collectStorage(warnings);
    const hostInfo = await this.collectHostInfo(admin, warnings);
    const serverParameters = await this.collectServerParameters(admin, warnings);

    return {
      sourceId: this.source.id,
      sourceName: this.source.name,
      collectedAt: new Date(),
      topology,
      serverStatus,
      replSetStatus,
      indexUsage,
      storage,
      hostInfo,
      serverParameters,
      collectionMethod: "direct",
      warnings,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // --- parsing helpers -----------------------------------------------------

  private parseServerStatus(
    raw: Record<string, any>,
    cmdLineOpts: Record<string, any> | undefined,
  ): ServerStatus {
    const connections: ConnectionStats = {
      current: raw.connections?.current ?? 0,
      available: raw.connections?.available ?? 0,
      totalCreated: raw.connections?.totalCreated ?? 0,
    };

    const opcounters: OpCounters = {
      insert: raw.opcounters?.insert ?? 0,
      query: raw.opcounters?.query ?? 0,
      update: raw.opcounters?.update ?? 0,
      delete: raw.opcounters?.delete ?? 0,
      getmore: raw.opcounters?.getmore ?? 0,
      command: raw.opcounters?.command ?? 0,
    };

    const wt = raw.wiredTiger?.cache;
    let wiredTigerCache: WiredTigerCache | undefined;
    if (wt) {
      wiredTigerCache = {
        bytesInCache: wt["bytes currently in the cache"] ?? 0,
        maxBytes: wt["maximum bytes configured"] ?? 0,
        dirtyBytes: wt["tracked dirty bytes in the cache"] ?? 0,
        pagesEvictedForcibly:
          wt["pages evicted by application threads"] ?? undefined,
      };
    }

    // Concurrency tickets moved location across versions; check both.
    const ticketsRaw =
      raw.wiredTiger?.concurrentTransactions ??
      raw.queues?.execution ??
      undefined;
    let tickets: ServerStatus["tickets"];
    if (ticketsRaw?.read && ticketsRaw?.write) {
      tickets = {
        readAvailable: ticketsRaw.read.available ?? 0,
        readOut: ticketsRaw.read.out ?? 0,
        writeAvailable: ticketsRaw.write.available ?? 0,
        writeOut: ticketsRaw.write.out ?? 0,
      };
    }

    const gl = raw.globalLock?.currentQueue;
    const globalLockQueue = gl
      ? { total: gl.total ?? 0, readers: gl.readers ?? 0, writers: gl.writers ?? 0 }
      : undefined;

    const parsed = cmdLineOpts?.parsed ?? {};
    const security: ServerStatus["security"] = cmdLineOpts
      ? {
          authEnabled:
            parsed.security?.authorization === "enabled" ||
            Boolean(parsed.auth) ||
            Array.isArray(parsed.setParameter),
          tlsEnabled:
            parsed.net?.tls?.mode != null &&
            parsed.net?.tls?.mode !== "disabled",
        }
      : undefined;

    return {
      host: raw.host ?? "unknown",
      version: raw.version ?? "0.0.0",
      processName: raw.process ?? "mongod",
      uptimeSec: raw.uptime ?? 0,
      connections,
      opcounters,
      wiredTigerCache,
      tickets,
      globalLockQueue,
      security,
    };
  }

  private parseReplSetStatus(raw: Record<string, any>): ReplSetStatus {
    const members: ReplMember[] = (raw.members ?? []).map((m: any) => ({
      _id: m._id,
      name: m.name,
      health: m.health === 1 ? 1 : 0,
      state: m.state,
      stateStr: m.stateStr,
      uptimeSec: m.uptime ?? 0,
      optimeDate: m.optimeDate ? new Date(m.optimeDate) : undefined,
      pingMs: typeof m.pingMs === "number" ? m.pingMs : undefined,
      self: Boolean(m.self),
      // votes/priority live in replSetGetConfig; default sensibly here.
      votes: m.votes ?? 1,
      priority: m.priority ?? 1,
    }));

    return {
      set: raw.set,
      myStateStr: raw.myState != null ? stateToStr(raw.myState) : "UNKNOWN",
      members,
    };
  }

  private deriveTopology(
    serverStatus: ServerStatus,
    repl?: ReplSetStatus,
  ): Topology {
    if (repl) {
      return {
        type: "replicaSet",
        mongoVersion: serverStatus.version,
        setName: repl.set,
        nodeCount: repl.members.length,
      };
    }
    // mongos reports process "mongos".
    if (serverStatus.processName === "mongos") {
      return {
        type: "sharded",
        mongoVersion: serverStatus.version,
        nodeCount: 1,
      };
    }
    return {
      type: "standalone",
      mongoVersion: serverStatus.version,
      nodeCount: 1,
    };
  }

  /**
   * Storage facts via dbStats. Aggregates data/index sizes across user
   * databases and captures instance-wide filesystem usage (WiredTiger reports
   * fsUsedSize/fsTotalSize in dbStats). Missing privilege → warning, not failure.
   */
  /** Host hardware (RAM/cores/OS) via hostInfo — gives real limits for capacity. */
  private async collectHostInfo(admin: Db, warnings: string[]): Promise<HostInfo | undefined> {
    const raw = await this.safeCommand(admin, { hostInfo: 1 }, warnings, undefined, true);
    if (!raw) return undefined;
    const system = raw.system ?? {};
    const os = raw.os ?? {};
    return {
      hostname: system.hostname,
      cpuCores: system.numCores ?? system.numPhysicalCores,
      memSizeMB: system.memSizeMB ?? system.memLimitMB,
      os: os.type ? `${os.type}${os.version ? " " + os.version : ""}` : os.name,
      numaEnabled: system.numaEnabled,
      extra: raw.extra && typeof raw.extra === "object" ? raw.extra : undefined,
    };
  }

  /** Selected server parameters (getParameter '*') for config-risk checks. */
  private async collectServerParameters(
    admin: Db,
    warnings: string[],
  ): Promise<Record<string, unknown> | undefined> {
    const raw = await this.safeCommand(admin, { getParameter: "*" }, warnings, undefined, true);
    if (!raw) return undefined;
    // Drop the command envelope fields.
    const { ok, operationTime, $clusterTime, ...params } = raw as Record<string, unknown>;
    void ok;
    void operationTime;
    void $clusterTime;
    return params;
  }

  private async collectStorage(warnings: string[]): Promise<StorageFacts | undefined> {
    try {
      const adminDb = this.client.db("admin");
      const { databases } = await adminDb.command({ listDatabases: 1 });
      const skip = new Set(["admin", "local", "config"]);
      const perDb: NonNullable<StorageFacts["databases"]> = [];
      let dataSize = 0;
      let indexSize = 0;
      let fsUsed: number | undefined;
      let fsTotal: number | undefined;

      for (const dbInfo of databases as Array<{ name: string }>) {
        if (skip.has(dbInfo.name)) continue;
        let stats: Record<string, any>;
        try {
          stats = await this.client.db(dbInfo.name).command({ dbStats: 1 });
        } catch {
          continue;
        }
        const ds = Number(stats.dataSize ?? 0);
        const is = Number(stats.indexSize ?? 0);
        dataSize += ds;
        indexSize += is;
        if (fsUsed == null && stats.fsUsedSize != null) fsUsed = Number(stats.fsUsedSize);
        if (fsTotal == null && stats.fsTotalSize != null) fsTotal = Number(stats.fsTotalSize);
        perDb.push({
          name: dbInfo.name,
          dataSize: ds,
          indexSize: is,
          collections: Number(stats.collections ?? 0),
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
    } catch (err) {
      warnings.push(`storage (dbStats) collection skipped: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async collectIndexUsage(
    warnings: string[],
  ): Promise<IndexUsage[] | undefined> {
    const usage: IndexUsage[] = [];
    try {
      const adminDb = this.client.db("admin");
      const { databases } = await adminDb.command({ listDatabases: 1 });
      const skip = new Set(["admin", "local", "config"]);
      for (const dbInfo of databases as Array<{ name: string }>) {
        if (skip.has(dbInfo.name)) continue;
        const db = this.client.db(dbInfo.name);
        const collections = await db.listCollections({}, { nameOnly: true }).toArray();
        for (const coll of collections) {
          if (coll.type && coll.type !== "collection") continue;
          await this.collectCollIndexStats(db, dbInfo.name, coll.name, usage, warnings);
        }
      }
    } catch (err) {
      warnings.push(`index usage collection skipped: ${(err as Error).message}`);
      return undefined;
    }
    return usage;
  }

  private async collectCollIndexStats(
    db: Db,
    dbName: string,
    collName: string,
    out: IndexUsage[],
    warnings: string[],
  ): Promise<void> {
    try {
      const stats = await db
        .collection(collName)
        .aggregate([{ $indexStats: {} }])
        .toArray();
      for (const s of stats as any[]) {
        out.push({
          db: dbName,
          collection: collName,
          name: s.name,
          ops: s.accesses?.ops ?? 0,
          keys: s.key ?? {},
        });
      }
    } catch (err) {
      // Collect once; don't spam a warning per collection.
      const msg = `$indexStats failed on ${dbName}.${collName}: ${(err as Error).message}`;
      if (!warnings.some((w) => w.startsWith("$indexStats failed"))) {
        warnings.push(msg);
      }
    }
  }

  /** Run a command, converting failures into a warning (or silently skipping). */
  private async safeCommand(
    db: Db,
    cmd: Record<string, unknown>,
    warnings: string[],
    warningMsg?: string,
    silent = false,
  ): Promise<Record<string, any> | undefined> {
    try {
      return await db.command(cmd);
    } catch (err) {
      if (!silent) {
        warnings.push(
          warningMsg ?? `command ${Object.keys(cmd)[0]} failed: ${(err as Error).message}`,
        );
      }
      return undefined;
    }
  }
}

/** Replica set numeric state → string, for myState which has no string form. */
function stateToStr(state: number): string {
  const map: Record<number, string> = {
    0: "STARTUP",
    1: "PRIMARY",
    2: "SECONDARY",
    3: "RECOVERING",
    5: "STARTUP2",
    6: "UNKNOWN",
    7: "ARBITER",
    8: "DOWN",
    9: "ROLLBACK",
    10: "REMOVED",
  };
  return map[state] ?? `STATE_${state}`;
}
