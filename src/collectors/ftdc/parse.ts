import type {
  CollectedFacts,
  ConnectionStats,
  HostInfo,
  MetricSeries,
  OpCounters,
  ServerStatus,
  Topology,
  WiredTigerCache,
} from "../../core/types.js";
import { decodeFtdc, type FtdcChunk } from "./decode.js";
import { bucketPoints, defaultBucketMs, aggForMetric } from "./downsample.js";

/**
 * Parses MongoDB FTDC (`diagnostic.data/metrics.*`) binary archive files into:
 *  - `facts`: a CollectedFacts snapshot (version/hostInfo/serverStatus) built
 *    from the newest metadata + latest metric sample — like getMongoData, so an
 *    FTDC import produces a scan + health score.
 *  - `series`: canonical capacity time-series (CPU / WiredTiger cache / disk /
 *    IOPS) plus a curated set of serverStatus counters, so the capacity engine
 *    works for offline clusters that have no Atlas/OpsManager metrics API.
 *
 * FTDC is the offline equivalent of the Atlas/OM metrics history: it is sampled
 * ~once per second by mongod itself and persisted on the host, so it's the only
 * way to get real CPU/memory/disk trends from a network-isolated deployment.
 */

export interface ParsedFtdc {
  facts: Omit<CollectedFacts, "sourceId" | "sourceName">;
  /** Series WITHOUT sourceId (filled in by the service). processId = host:port. */
  series: Omit<MetricSeries, "sourceId">[];
  host?: string;
  /** Count of samples decoded across all chunks (for reporting). */
  sampleCount: number;
  /** Earliest / latest sample timestamp (ms since epoch) across all chunks. */
  firstTs?: number;
  lastTs?: number;
}

/** Parse one or more concatenated FTDC archive files (Buffers). */
export function parseFtdc(buffers: Buffer | Buffer[]): ParsedFtdc {
  const warnings: string[] = [];
  const bufs = Array.isArray(buffers) ? buffers : [buffers];

  // Decode every file; collect all chunks and the newest metadata snapshot.
  const chunks: FtdcChunk[] = [];
  let metadata: Record<string, unknown> | null = null;
  for (const buf of bufs) {
    try {
      const r = decodeFtdc(buf);
      chunks.push(...r.chunks);
      if (r.metadata) metadata = r.metadata;
      warnings.push(...r.warnings);
    } catch (err) {
      warnings.push(`FTDC: ${(err as Error).message}`);
    }
  }
  if (chunks.length === 0) {
    throw new Error("No decodable FTDC metric chunks found in the provided file(s).");
  }

  // Sort chunks by first timestamp so "latest" is well-defined.
  chunks.sort((a, b) => (a.timestamps[0] ?? 0) - (b.timestamps[0] ?? 0));
  const lastChunk = chunks[chunks.length - 1]!;

  const host = deriveHost(metadata, lastChunk);
  const numCores = getNumCores(metadata) ?? 1;

  const facts = buildFacts(metadata, lastChunk, warnings);
  const series = buildSeries(chunks, host, numCores);
  const sampleCount = chunks.reduce((n, c) => n + c.sampleCount, 0);

  const firstChunk = chunks[0]!;
  const firstTs = firstChunk.timestamps[0];
  const lastTs = lastChunk.timestamps[lastChunk.sampleCount - 1];

  return { facts, series, host, sampleCount, firstTs, lastTs };
}

// --- facts (snapshot) ------------------------------------------------------

function buildFacts(
  metadata: Record<string, unknown> | null,
  lastChunk: FtdcChunk,
  warnings: string[],
): Omit<CollectedFacts, "sourceId" | "sourceName"> {
  const buildInfo = (metadata?.buildInfo ?? {}) as any;
  const hostInfoRaw = (metadata?.hostInfo ?? {}) as any;
  const cmdLine = (metadata?.getCmdLineOpts ?? {}) as any;

  // Latest serverStatus values from the final sample of the newest chunk.
  const ss = sampleValues(lastChunk, lastChunk.sampleCount - 1, "serverStatus");

  const version =
    (ss["version"] as string | undefined) ??
    buildInfo.version ??
    "unknown";

  const connections: ConnectionStats = {
    current: num(ss["connections.current"]),
    available: num(ss["connections.available"]),
    totalCreated: num(ss["connections.totalCreated"]),
  };
  const opcounters: OpCounters = {
    insert: num(ss["opcounters.insert"]),
    query: num(ss["opcounters.query"]),
    update: num(ss["opcounters.update"]),
    delete: num(ss["opcounters.delete"]),
    getmore: num(ss["opcounters.getmore"]),
    command: num(ss["opcounters.command"]),
  };

  let wiredTigerCache: WiredTigerCache | undefined;
  const wtBytes = ss["wiredTiger.cache.bytes currently in the cache"];
  if (wtBytes != null) {
    wiredTigerCache = {
      bytesInCache: num(wtBytes),
      maxBytes: num(ss["wiredTiger.cache.maximum bytes configured"]),
      dirtyBytes: num(ss["wiredTiger.cache.tracked dirty bytes in the cache"]),
    };
  }

  const gqTotal = ss["globalLock.currentQueue.total"];
  const globalLockQueue =
    gqTotal != null
      ? {
          total: num(gqTotal),
          readers: num(ss["globalLock.currentQueue.readers"]),
          writers: num(ss["globalLock.currentQueue.writers"]),
        }
      : undefined;

  // Concurrency tickets (WiredTiger) — path differs across versions.
  const tickets = buildTickets(ss);

  const parsed = cmdLine?.parsed ?? {};
  const security = {
    authEnabled:
      parsed.security?.authorization === "enabled" || Boolean(parsed.auth),
    tlsEnabled: parsed.net?.tls?.mode != null && parsed.net?.tls?.mode !== "disabled",
  };

  const serverStatus: ServerStatus = {
    host: host(metadata) ?? "unknown",
    version,
    processName: "mongod",
    uptimeSec: num(ss["uptime"]),
    connections,
    opcounters,
    wiredTigerCache,
    tickets,
    globalLockQueue,
    security,
  };

  const hostInfo = buildHostInfo(hostInfoRaw);
  const topology = deriveTopology(version, hostInfoRaw);

  if (!metadata) warnings.push("FTDC: no type-0 metadata document; facts are from metric samples only.");

  return {
    collectedAt: new Date(lastChunk.timestamps[lastChunk.sampleCount - 1] ?? Date.now()),
    topology,
    serverStatus,
    hostInfo,
    collectionMethod: "offline",
    warnings,
  };
}

function buildTickets(ss: Record<string, number>): ServerStatus["tickets"] {
  const rAvail =
    ss["wiredTiger.concurrentTransactions.read.available"] ??
    ss["queues.execution.read.available"];
  const wAvail =
    ss["wiredTiger.concurrentTransactions.write.available"] ??
    ss["queues.execution.write.available"];
  if (rAvail == null || wAvail == null) return undefined;
  return {
    readAvailable: num(rAvail),
    readOut: num(
      ss["wiredTiger.concurrentTransactions.read.out"] ?? ss["queues.execution.read.out"],
    ),
    writeAvailable: num(wAvail),
    writeOut: num(
      ss["wiredTiger.concurrentTransactions.write.out"] ?? ss["queues.execution.write.out"],
    ),
  };
}

function buildHostInfo(raw: any): HostInfo | undefined {
  const system = raw?.system ?? {};
  const os = raw?.os ?? {};
  if (!system.hostname && !system.memSizeMB && !system.numCores) return undefined;
  return {
    hostname: system.hostname,
    cpuCores: system.numCores ?? system.numPhysicalCores,
    memSizeMB: system.memSizeMB ?? system.memLimitMB,
    os: os.name ? `${os.name}${os.version ? " " + os.version : ""}` : undefined,
    numaEnabled: system.numaEnabled,
    extra: raw?.extra && typeof raw.extra === "object" ? raw.extra : undefined,
  };
}

function deriveTopology(version: string, hostInfoRaw: any): Topology {
  // FTDC alone can't always tell replset membership; default to standalone and
  // let a companion getMongoData import refine it. If replSetGetStatus data is
  // present in future, this can be extended.
  void hostInfoRaw;
  return { type: "standalone", mongoVersion: version, nodeCount: 1 };
}

// --- time series -----------------------------------------------------------

/**
 * Canonical capacity keys the engine understands (see src/capacity/engine.ts):
 *   SYSTEM_NORMALIZED_CPU_USER / _KERNEL  (0–100 per core)
 *   CACHE_USED_BYTES                       (bytes)
 *   DISK_PARTITION_SPACE_USED / _FREE      (bytes)
 *   DISK_PARTITION_IOPS_TOTAL              (ops/s)
 * Plus a curated allowlist of serverStatus counters for charts/chat.
 */
function buildSeries(
  chunks: FtdcChunk[],
  host: string | undefined,
  numCores: number,
): Omit<MetricSeries, "sourceId">[] {
  const processId = host;
  const out: Omit<MetricSeries, "sourceId">[] = [];

  // --- WiredTiger cache used (gauge, bytes) ---
  pushGauge(out, chunks, processId, "serverStatus.wiredTiger.cache.bytes currently in the cache", "CACHE_USED_BYTES", "bytes");

  // --- Direct gauges from serverStatus (bytes / counts) ---
  pushGauge(out, chunks, processId, "serverStatus.connections.current", "CONNECTIONS", "count");

  // --- CPU: cumulative ms counters → normalized % per core ---
  pushCpuNormalized(
    out, chunks, processId,
    "SYSTEM_NORMALIZED_CPU_USER",
    ["systemMetrics.cpu.user_ms", "systemMetrics.cpu.nice_ms"],
    numCores,
  );
  pushCpuNormalized(
    out, chunks, processId,
    "SYSTEM_NORMALIZED_CPU_KERNEL",
    ["systemMetrics.cpu.system_ms", "systemMetrics.cpu.irq_ms", "systemMetrics.cpu.softirq_ms"],
    numCores,
  );

  // --- Disk space + IOPS from systemMetrics.mounts / systemMetrics.disks ---
  buildDiskSeries(out, chunks, processId);

  // --- Opcounters → per-second rates (useful for workload trend) ---
  for (const [path, metric] of [
    ["serverStatus.opcounters.query", "OPCOUNTER_QUERY"],
    ["serverStatus.opcounters.insert", "OPCOUNTER_INSERT"],
    ["serverStatus.opcounters.update", "OPCOUNTER_UPDATE"],
    ["serverStatus.opcounters.delete", "OPCOUNTER_DELETE"],
  ] as const) {
    pushRate(out, chunks, processId, path, metric, "ops/s");
  }

  // Downsample every series to the shared bucket resolution (hourly by default)
  // BEFORE it reaches the metric store — FTDC's ~1 Hz sampling is ~3,600× finer
  // than needed and would otherwise store tens of millions of points per node.
  const bucketMs = defaultBucketMs();
  for (const s of out) {
    s.points = bucketPoints(s.points, bucketMs, aggForMetric(s.metric));
  }

  return out.filter((s) => s.points.length > 0);
}

/** A gauge: value as-is at each sample timestamp. */
function pushGauge(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
  path: string,
  metric: string,
  units: string,
): void {
  const points: { ts: Date; value: number }[] = [];
  for (const c of chunks) {
    const i = c.paths.indexOf(path);
    if (i < 0) continue;
    const row = c.values[i]!;
    for (let s = 0; s < c.sampleCount; s++) {
      points.push({ ts: new Date(c.timestamps[s]!), value: row[s]! });
    }
  }
  if (points.length) out.push({ processId, metric, units, points });
}

/** A counter → per-second rate (delta / interval). First sample is dropped. */
function pushRate(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
  path: string,
  metric: string,
  units: string,
): void {
  const points: { ts: Date; value: number }[] = [];
  let prev: { v: number; t: number } | null = null;
  for (const c of chunks) {
    const i = c.paths.indexOf(path);
    if (i < 0) {
      prev = null;
      continue;
    }
    const row = c.values[i]!;
    for (let s = 0; s < c.sampleCount; s++) {
      const v = row[s]!;
      const t = c.timestamps[s]!;
      if (prev && t > prev.t) {
        const dt = (t - prev.t) / 1000;
        const dv = v - prev.v;
        if (dt > 0 && dv >= 0) points.push({ ts: new Date(t), value: dv / dt });
      }
      prev = { v, t };
    }
  }
  if (points.length) out.push({ processId, metric, units, points });
}

/**
 * CPU normalized to 0–100 per core. The listed cumulative-ms counters are
 * summed, then the per-interval delta is divided by (interval_ms × numCores)
 * and scaled to a percentage — matching Atlas SYSTEM_NORMALIZED_CPU_* semantics.
 */
function pushCpuNormalized(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
  metric: string,
  paths: string[],
  numCores: number,
): void {
  const points: { ts: Date; value: number }[] = [];
  let prev: { v: number; t: number } | null = null;
  for (const c of chunks) {
    const idxs = paths.map((p) => c.paths.indexOf(p));
    if (idxs.every((i) => i < 0)) {
      prev = null;
      continue;
    }
    for (let s = 0; s < c.sampleCount; s++) {
      let sum = 0;
      for (const i of idxs) if (i >= 0) sum += c.values[i]![s]!;
      const t = c.timestamps[s]!;
      if (prev && t > prev.t) {
        const dtMs = t - prev.t;
        const dMs = sum - prev.v;
        if (dtMs > 0 && dMs >= 0) {
          const pct = (dMs / (dtMs * Math.max(1, numCores))) * 100;
          points.push({ ts: new Date(t), value: Math.min(100, Math.max(0, pct)) });
        }
      }
      prev = { v: sum, t };
    }
  }
  if (points.length) out.push({ processId, metric, units: "%", points });
}

/**
 * Disk space (bytes) from systemMetrics.mounts.<mount> and IOPS from
 * systemMetrics.disks.<dev>. Picks the mount with the largest capacity (the
 * data partition, best-effort) and sums IOPS across physical disks.
 */
function buildDiskSeries(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
): void {
  // Identify mount with largest capacity in the latest chunk.
  const last = chunks[chunks.length - 1]!;
  const mountPrefix = "systemMetrics.mounts.";
  const mounts = new Set<string>();
  for (const p of last.paths) {
    if (p.startsWith(mountPrefix)) {
      const rest = p.slice(mountPrefix.length);
      const mount = rest.slice(0, rest.lastIndexOf("."));
      if (mount) mounts.add(mount);
    }
  }
  let best: string | undefined;
  let bestCap = -1;
  for (const m of mounts) {
    const i = last.paths.indexOf(`${mountPrefix}${m}.capacity`);
    if (i >= 0) {
      const cap = last.values[i]![last.sampleCount - 1]!;
      if (cap > bestCap) {
        bestCap = cap;
        best = m;
      }
    }
  }
  if (best) {
    const freePath = `${mountPrefix}${best}.free`;
    const capPath = `${mountPrefix}${best}.capacity`;
    const availPath = `${mountPrefix}${best}.available`;
    // FREE = free bytes; USED = capacity - available.
    pushGauge(out, chunks, processId, freePath, "DISK_PARTITION_SPACE_FREE", "bytes");
    pushDerived(
      out, chunks, processId, "DISK_PARTITION_SPACE_USED", "bytes",
      [capPath, availPath],
      ([cap, avail]) => (cap != null && avail != null ? cap - avail : undefined),
    );
  }

  // IOPS: sum of (reads+writes) deltas across physical disks → ops/s.
  const diskPrefix = "systemMetrics.disks.";
  const disks = new Set<string>();
  for (const p of last.paths) {
    if (p.startsWith(diskPrefix)) {
      const rest = p.slice(diskPrefix.length);
      const dev = rest.slice(0, rest.lastIndexOf("."));
      if (dev) disks.add(dev);
    }
  }
  if (disks.size > 0) {
    pushIopsTotal(out, chunks, processId, [...disks], diskPrefix);
  }
}

/** A gauge derived from several paths via `fn`, evaluated per sample. */
function pushDerived(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
  metric: string,
  units: string,
  paths: string[],
  fn: (vals: (number | undefined)[]) => number | undefined,
): void {
  const points: { ts: Date; value: number }[] = [];
  for (const c of chunks) {
    const idxs = paths.map((p) => c.paths.indexOf(p));
    if (idxs.some((i) => i < 0)) continue;
    for (let s = 0; s < c.sampleCount; s++) {
      const vals = idxs.map((i) => c.values[i]![s]!);
      const v = fn(vals);
      if (v != null && Number.isFinite(v)) points.push({ ts: new Date(c.timestamps[s]!), value: v });
    }
  }
  if (points.length) out.push({ processId, metric, units, points });
}

/** Total IOPS = Σ_disks Δ(reads+writes) / Δt, as a per-second rate. */
function pushIopsTotal(
  out: Omit<MetricSeries, "sourceId">[],
  chunks: FtdcChunk[],
  processId: string | undefined,
  disks: string[],
  prefix: string,
): void {
  const points: { ts: Date; value: number }[] = [];
  let prev: { v: number; t: number } | null = null;
  for (const c of chunks) {
    const pairs = disks
      .map((d) => [c.paths.indexOf(`${prefix}${d}.reads`), c.paths.indexOf(`${prefix}${d}.writes`)])
      .filter(([r, w]) => r! >= 0 && w! >= 0);
    if (pairs.length === 0) {
      prev = null;
      continue;
    }
    for (let s = 0; s < c.sampleCount; s++) {
      let total = 0;
      for (const [r, w] of pairs) total += c.values[r!]![s]! + c.values[w!]![s]!;
      const t = c.timestamps[s]!;
      if (prev && t > prev.t) {
        const dt = (t - prev.t) / 1000;
        const dv = total - prev.v;
        if (dt > 0 && dv >= 0) points.push({ ts: new Date(t), value: dv / dt });
      }
      prev = { v: total, t };
    }
  }
  if (points.length) out.push({ processId, metric: "DISK_PARTITION_IOPS_TOTAL", units: "ops/s", points });
}

// --- helpers ---------------------------------------------------------------

/** Extract { subpathAfterSection → value } from one sample of a chunk. */
function sampleValues(chunk: FtdcChunk, sample: number, section: string): Record<string, number> {
  const prefix = `${section}.`;
  const out: Record<string, number> = {};
  for (let i = 0; i < chunk.paths.length; i++) {
    const p = chunk.paths[i]!;
    if (p.startsWith(prefix)) out[p.slice(prefix.length)] = chunk.values[i]![sample]!;
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function getNumCores(metadata: Record<string, unknown> | null): number | undefined {
  const sys = (metadata?.hostInfo as any)?.system;
  return sys?.numCores ?? sys?.numPhysicalCores;
}

function host(metadata: Record<string, unknown> | null): string | undefined {
  return (metadata?.hostInfo as any)?.system?.hostname;
}

function deriveHost(metadata: Record<string, unknown> | null, lastChunk: FtdcChunk): string | undefined {
  const h = host(metadata);
  if (h) return h;
  const i = lastChunk.paths.indexOf("serverStatus.host");
  void i;
  return undefined;
}
