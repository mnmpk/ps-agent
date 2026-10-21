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
 * Parses the output of MongoDB's getMongoData.js support script into our
 * CollectedFacts. getMongoData produces a JSON array of
 *   { section, subsection, output, host, ts, ... }
 * entries (EJSON with {$numberLong},{$date},{$oid}). This parser is defensive:
 * script versions vary and sections may be missing/partial, so anything it
 * can't read becomes a warning rather than an error.
 */

interface GmdEntry {
  section?: string;
  subsection?: string;
  output?: unknown;
  host?: string;
  error?: unknown;
}

export interface ParsedGetMongoData {
  facts: Omit<CollectedFacts, "sourceId" | "sourceName">;
  /** Best-effort hostname/identity for naming the source. */
  host?: string;
}

export function parseGetMongoData(raw: string): ParsedGetMongoData {
  const warnings: string[] = [];
  const entries = loadEntries(raw, warnings);

  const get = (section: string, subsection: string): any => {
    const e = entries.find(
      (x) => x.section === section && x.subsection === subsection,
    );
    return e ? ejson(e.output) : undefined;
  };
  // Some sections have no subsection (section === the label).
  const getByLabel = (label: string): any => {
    const e = entries.find((x) => x.section === label || x.subsection === label);
    return e ? ejson(e.output) : undefined;
  };

  const serverStatusRaw = get("server_info", "server_status_info") ?? getByLabel("server_status_info");
  const cmdLineRaw = get("server_info", "command_line_info") ?? getByLabel("command_line_info");
  const hostInfoRaw = get("server_info", "host_info") ?? getByLabel("host_info");
  const buildInfoRaw = get("server_info", "server_build_info") ?? getByLabel("server_build_info");
  const serverParamsRaw = get("server_info", "server_parameters") ?? getByLabel("server_parameters");

  const serverStatus = serverStatusRaw
    ? parseServerStatus(serverStatusRaw, cmdLineRaw)
    : undefined;
  if (!serverStatus) warnings.push("getMongoData: no server_status_info section found.");

  const hostInfo = hostInfoRaw ? parseHostInfo(hostInfoRaw) : undefined;
  const serverParameters =
    serverParamsRaw && typeof serverParamsRaw === "object"
      ? (serverParamsRaw as Record<string, unknown>)
      : undefined;

  // Replica set status (replSetGetStatus) + config (replSetGetConfig). Status has
  // live state/health; config has votes/priority/hidden/arbiterOnly — merge them.
  const replRaw = get("replicaset_info", "replica_status") ?? getByLabel("replica_status");
  const replCfgRaw = get("replicaset_info", "replica_set_config") ?? getByLabel("replica_set_config");
  const replSetStatus = replRaw ? parseReplSetStatus(replRaw, replCfgRaw) : undefined;

  const topology = deriveTopology(serverStatus, replSetStatus, buildInfoRaw);

  // Storage + index usage from data_info entries (there can be many).
  const { storage, indexUsage } = parseDataInfo(entries, warnings);

  const host =
    serverStatus?.host ??
    hostInfo?.hostname ??
    entries.find((e) => e.host)?.host;

  return {
    host,
    facts: {
      collectedAt: new Date(),
      topology,
      serverStatus,
      replSetStatus,
      indexUsage: indexUsage.length ? indexUsage : undefined,
      storage,
      hostInfo,
      serverParameters,
      collectionMethod: "offline",
      warnings,
    },
  };
}

// --- loading / EJSON -------------------------------------------------------

function loadEntries(raw: string, warnings: string[]): GmdEntry[] {
  const text = stripTrailingError(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some logs may have a trailing comma or the "ERROR:" footer; try to salvage
    // the JSON array by trimming to the last ']'.
    const end = text.lastIndexOf("]");
    if (end > 0) {
      try {
        parsed = JSON.parse(text.slice(0, end + 1));
      } catch {
        throw new Error("getMongoData file is not valid JSON.");
      }
    } else {
      throw new Error("getMongoData file is not valid JSON.");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("getMongoData file must be a JSON array (run with default _printJSON).");
  }
  return parsed as GmdEntry[];
}

/** getMongoData appends a non-JSON "ERROR: ..." line on failure; drop it. */
function stripTrailingError(raw: string): string {
  const idx = raw.lastIndexOf("\nERROR:");
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

/**
 * Recursively convert canonical EJSON wrappers to plain JS. mongosh emits
 * {$numberInt}, {$numberLong}, {$numberDouble}, {$numberDecimal}, {$oid}, {$date}.
 */
function ejson(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(ejson);
  if (typeof v === "object") {
    if ("$numberInt" in v) return Number(v.$numberInt);
    if ("$numberLong" in v) return Number(v.$numberLong);
    if ("$numberDouble" in v) return Number(v.$numberDouble);
    if ("$numberDecimal" in v) return Number(v.$numberDecimal);
    if ("$oid" in v) return v.$oid;
    if ("$date" in v) {
      const d = v.$date;
      const ms =
        typeof d === "object"
          ? Number(d.$numberLong ?? d.$numberInt ?? d)
          : typeof d === "string"
            ? Date.parse(d)
            : d;
      return new Date(ms);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = ejson(val);
    return out;
  }
  return v;
}

// --- section parsers -------------------------------------------------------

function parseServerStatus(raw: any, cmdLineOpts: any): ServerStatus {
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
    };
  }
  const ticketsRaw =
    raw.wiredTiger?.concurrentTransactions ?? raw.queues?.execution ?? undefined;
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
  const security = cmdLineOpts
    ? {
        authEnabled:
          parsed.security?.authorization === "enabled" || Boolean(parsed.auth),
        tlsEnabled:
          parsed.net?.tls?.mode != null && parsed.net?.tls?.mode !== "disabled",
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

function parseHostInfo(raw: any): HostInfo {
  const system = raw.system ?? {};
  const os = raw.os ?? {};
  return {
    hostname: system.hostname,
    cpuCores: system.numCores ?? system.numPhysicalCores,
    memSizeMB: system.memSizeMB ?? system.memLimitMB,
    os: os.name ? `${os.name}${os.version ? " " + os.version : ""}` : undefined,
    numaEnabled: system.numaEnabled,
    extra: raw.extra && typeof raw.extra === "object" ? raw.extra : undefined,
  };
}

function parseReplSetStatus(raw: any, cfgRaw?: any): ReplSetStatus {
  // Build a config lookup (votes/priority/hidden/arbiterOnly) keyed by host name
  // and by _id — replSetGetStatus doesn't carry these; replSetGetConfig does.
  const cfgMembers: any[] = cfgRaw?.members ?? cfgRaw?.config?.members ?? [];
  const cfgByHost = new Map<string, any>();
  const cfgById = new Map<number, any>();
  for (const cm of cfgMembers) {
    if (typeof cm?.host === "string") cfgByHost.set(cm.host, cm);
    if (cm?._id != null) cfgById.set(Number(cm._id), cm);
  }

  const members: ReplMember[] = (raw.members ?? []).map((m: any) => {
    const cfg = cfgByHost.get(m.name) ?? (m._id != null ? cfgById.get(Number(m._id)) : undefined);
    return {
      _id: m._id,
      name: m.name,
      health: m.health === 1 ? 1 : 0,
      state: m.state,
      stateStr: m.stateStr,
      uptimeSec: m.uptime ?? 0,
      optimeDate: m.optimeDate ? new Date(m.optimeDate) : undefined,
      pingMs: typeof m.pingMs === "number" ? m.pingMs : undefined,
      self: Boolean(m.self),
      // Prefer real config values; fall back to any status value, else defaults.
      votes: cfg?.votes ?? m.votes ?? 1,
      priority: cfg?.priority ?? m.priority ?? 1,
      hidden: cfg?.hidden ?? undefined,
      arbiterOnly: cfg?.arbiterOnly ?? undefined,
    };
  });
  return {
    set: raw.set,
    myStateStr: typeof raw.myState === "number" ? stateToStr(raw.myState) : "UNKNOWN",
    members,
  };
}

function parseDataInfo(
  entries: GmdEntry[],
  warnings: string[],
): { storage?: StorageFacts; indexUsage: IndexUsage[] } {
  const dbStats = entries.filter(
    (e) => e.section === "data_info" && e.subsection?.startsWith("database_stats"),
  );
  const perDb: NonNullable<StorageFacts["databases"]> = [];
  let dataSize = 0;
  let indexSize = 0;
  let fsUsed: number | undefined;
  let fsTotal: number | undefined;

  for (const e of dbStats) {
    const s = ejson(e.output);
    if (!s || typeof s !== "object") continue;
    // getMongoData runs stats(1024*1024) → values already in MB. Convert to bytes.
    const MB = 1024 * 1024;
    const ds = (s.dataSize ?? 0) * MB;
    const is = (s.indexSize ?? 0) * MB;
    dataSize += ds;
    indexSize += is;
    if (fsUsed == null && s.fsUsedSize != null) fsUsed = s.fsUsedSize * MB;
    if (fsTotal == null && s.fsTotalSize != null) fsTotal = s.fsTotalSize * MB;
    if (s.db && s.db !== "admin" && s.db !== "local" && s.db !== "config") {
      perDb.push({
        name: s.db,
        dataSize: ds,
        indexSize: is,
        collections: s.collections ?? 0,
      });
    }
  }

  const storage: StorageFacts | undefined =
    perDb.length || fsUsed != null
      ? {
          fsUsedBytes: fsUsed,
          fsTotalBytes: fsTotal,
          dataSizeBytes: dataSize,
          indexSizeBytes: indexSize,
          databases: perDb,
        }
      : undefined;

  // Index usage from index_stats entries.
  const indexUsage = parseIndexStats(entries, warnings);
  return { storage, indexUsage };
}

function parseIndexStats(entries: GmdEntry[], warnings: string[]): IndexUsage[] {
  const out: IndexUsage[] = [];
  const idxEntries = entries.filter(
    (e) => e.section === "data_info" && e.subsection === "index_stats",
  );
  for (const e of idxEntries) {
    const res = ejson(e.output);
    const batch = res?.cursor?.firstBatch;
    if (!Array.isArray(batch)) continue;
    // We don't always have db/collection on the grouped output; best-effort.
    for (const shape of batch) {
      const keys = shape.key ?? {};
      const stats = Array.isArray(shape.stats) ? shape.stats : [];
      const ops = stats.reduce((sum: number, s: any) => sum + (s.accesses ?? 0), 0);
      out.push({
        db: shape.db ?? "",
        collection: shape.collection ?? "",
        name: Object.keys(keys).map((k) => `${k}_${keys[k]}`).join("_") || "unknown",
        ops,
        keys,
      });
    }
  }
  return out;
}

function deriveTopology(
  serverStatus: ServerStatus | undefined,
  repl: ReplSetStatus | undefined,
  buildInfo: any,
): Topology {
  const version =
    serverStatus?.version ?? buildInfo?.version ?? "unknown";
  if (repl) {
    return {
      type: "replicaSet",
      mongoVersion: version,
      setName: repl.set,
      nodeCount: repl.members.length,
    };
  }
  if (serverStatus?.processName === "mongos") {
    return { type: "sharded", mongoVersion: version, nodeCount: 1 };
  }
  return { type: "standalone", mongoVersion: version, nodeCount: 1 };
}

function stateToStr(state: number): string {
  const map: Record<number, string> = {
    0: "STARTUP", 1: "PRIMARY", 2: "SECONDARY", 3: "RECOVERING", 5: "STARTUP2",
    6: "UNKNOWN", 7: "ARBITER", 8: "DOWN", 9: "ROLLBACK", 10: "REMOVED",
  };
  return map[state] ?? `STATE_${state}`;
}
