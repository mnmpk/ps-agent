import { randomUUID } from "node:crypto";
import type { Source } from "../core/source.js";
import type { ScanResult, CollectedFacts } from "../core/types.js";
import { runGraphScan, scoreFactsToScan } from "../agent/graphs/healthScanGraph.js";
import { parseGetMongoData } from "../collectors/getmongodata/parse.js";
import { parseMdiag } from "../collectors/mdiag/parse.js";
import { parseFtdc } from "../collectors/ftdc/parse.js";
import { detectDiagnostic, looksLikeJsonPrefix, type DiagnosticKind } from "../collectors/detect.js";
import { createNodeReconciler } from "../core/nodeIdentity.js";
import { redactSource } from "../store/sourceStore.js";
import { createStores } from "../store/factory.js";
import type { ScanStore, ScanSnapshotMeta } from "../store/store.js";
import type { SourceStore } from "../store/sourceStore.js";
import { createChatModelFromEnv } from "../agent/llm.js";
import {
  buildChatAgent,
  runChatTurn,
  streamChatTurn,
  type ChatResult,
  type ChatStreamEvent,
} from "../agent/graphs/chatGraph.js";
import type { AuditEntry, AuditLog } from "../store/auditLog.js";
import type { MetricSeriesStore } from "../store/metricStore.js";
import { createCheckpointer } from "../agent/checkpointer.js";
import { AtlasCollector } from "../collectors/atlas/atlasCollector.js";
import { OpsManagerCollector } from "../collectors/opsmanager/opsManagerCollector.js";
import type { ClusterSpec } from "../core/types.js";
import { computeCapacityReport } from "../capacity/engine.js";
import type { CapacityReport, QuerySignal } from "../capacity/types.js";
import { aggregateSlowQueries } from "../capacity/slowQuery.js";
import { DEFAULT_HISTORY } from "../capacity/historyBudget.js";
import { setActiveCatalog } from "../risks/catalog.js";
import { evaluateRisks } from "../risks/evaluators.js";
import { matchRisksWithLlm } from "../risks/llmMatcher.js";
import { llmConfigFromEnv } from "../agent/llm.js";
import type { CatalogStore } from "../store/catalogStore.js";
import type { RiskCatalogEntry } from "../risks/types.js";
import type { RiskReport, RiskAssessment } from "../risks/types.js";

function numEnvDays(): number {
  return DEFAULT_HISTORY.days;
}

/** Rough richness score for an FTDC facts snapshot (pick the most informative). */
function factsScore(f: Omit<CollectedFacts, "sourceId" | "sourceName">): number {
  let s = 0;
  if (f.hostInfo?.memSizeMB) s += 2;
  if (f.hostInfo?.cpuCores) s += 2;
  if (f.serverStatus?.version && f.serverStatus.version !== "unknown") s += 2;
  if (f.serverStatus?.wiredTigerCache) s += 1;
  return s;
}

/** Result of a unified diagnostic bundle import. */
export interface BundleImportResult {
  sourceId: string;
  sourceName: string;
  score: number;
  counts: { getMongoData: number; mdiag: number; ftdc: number; unknown: number };
  nodes: string[];
  metricPointsAdded: number;
  seriesCount: number;
  perFile: Array<{ filename: string; kind: DiagnosticKind; reason: string }>;
  warnings: string[];
}

/** Read the first `n` bytes of a file (for cheap content classification). */
async function readHead(path: string, n: number): Promise<Buffer> {
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Max number of per-import FTDC provenance events to retain on a source. */
const FTDC_PROVENANCE_MAX_IMPORTS = 50;

/**
 * Merge a new FTDC import event into a source's provenance record: append the
 * event (capped) and roll up per-node coverage (earliest→latest across imports).
 * Stores metadata only — never raw FTDC bytes.
 */
function mergeFtdcProvenance(
  existing: Source["ftdcProvenance"],
  batch: {
    input?: string;
    filesProcessed: number;
    nodes: string[];
    metricPointsAdded: number;
    from?: number;
    to?: number;
    nodeRange: Map<string, { from: number; to: number }>;
  },
): NonNullable<Source["ftdcProvenance"]> {
  const now = new Date().toISOString();
  const imports = [...(existing?.imports ?? [])];
  imports.push({
    at: now,
    input: batch.input,
    filesProcessed: batch.filesProcessed,
    nodes: batch.nodes,
    metricPointsAdded: batch.metricPointsAdded,
    coveredFrom: batch.from != null ? new Date(batch.from).toISOString() : undefined,
    coveredTo: batch.to != null ? new Date(batch.to).toISOString() : undefined,
  });
  // Cap retained events to the most recent N.
  const trimmed = imports.slice(-FTDC_PROVENANCE_MAX_IMPORTS);

  const nodesOut: NonNullable<Source["ftdcProvenance"]>["nodes"] = {
    ...(existing?.nodes ?? {}),
  };
  for (const [node, range] of batch.nodeRange) {
    if (!node) continue;
    const prev = nodesOut[node];
    const from = Math.min(prev ? Date.parse(prev.from) : Infinity, range.from);
    const to = Math.max(prev ? Date.parse(prev.to) : -Infinity, range.to);
    nodesOut[node] = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      lastImportedAt: now,
    };
  }

  return { imports: trimmed, nodes: nodesOut };
}

/** Sort key for risk assessments: detected/suggested first, then by level. */
function rankRisk(a: RiskAssessment): number {
  const statusRank: Record<string, number> = { detected: 0, suggested: 1, manual: 2, unknown: 3, clear: 4 };
  const levelRank: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
  return (statusRank[a.status] ?? 9) * 10 + (levelRank[a.risk.level] ?? 9);
}

export interface RegisterSourceInput {
  name: string;
  kind?: Source["kind"];
  connectionString?: string;
  atlas?: {
    projectId: string;
    publicKey: string;
    privateKey: string;
    clusterName?: string;
  };
  mcp?: {
    transport: "stdio" | "http";
    command?: string;
    url?: string;
  };
  opsManager?: {
    baseUrl: string;
    projectId: string;
    publicKey: string;
    privateKey: string;
  };
  tags?: string[];
}

/**
 * Application service used by both the CLI and the HTTP API. Owns the source
 * registry and scan execution/persistence so callers never touch the graph or
 * stores directly.
 */
export class HealthService {
  /** Lazily-built chat agent (shares one checkpointer for cross-turn memory). */
  private chatAgent?: ReturnType<typeof buildChatAgent>;

  private readonly sources: SourceStore;
  private readonly scans: ScanStore;
  private readonly audit: AuditLog;
  private readonly metrics: MetricSeriesStore;
  private readonly catalog: CatalogStore;
  /** Which persistence backend is active ("mongodb" | "file"). */
  readonly storeBackend: "mongodb" | "file";

  /**
   * By default the persistence backend is chosen by `createStores()`
   * (MongoDB when a store URI is configured, else local files). Individual
   * stores can be injected for testing.
   */
  constructor(overrides?: {
    sources?: SourceStore;
    scans?: ScanStore;
    audit?: AuditLog;
    metrics?: MetricSeriesStore;
    catalog?: CatalogStore;
  }) {
    const defaults = createStores();
    this.sources = overrides?.sources ?? defaults.sources;
    this.scans = overrides?.scans ?? defaults.scans;
    this.audit = overrides?.audit ?? defaults.audit;
    this.metrics = overrides?.metrics ?? defaults.metrics;
    this.catalog = overrides?.catalog ?? defaults.catalog;
    this.storeBackend = defaults.backend;
    // Prime the active (enabled-only) catalog for scan-time risk findings.
    void this.refreshActiveCatalog();
  }

  /** Reload the active (enabled) catalog into the risk engine. */
  private async refreshActiveCatalog(): Promise<void> {
    try {
      const all = await this.catalog.list();
      setActiveCatalog(all.filter((r) => r.enabled !== false));
    } catch {
      /* falls back to seed in getActiveCatalog */
    }
  }

  // --- risk catalog management ---------------------------------------------

  async listCatalog(): Promise<RiskCatalogEntry[]> {
    return this.catalog.list();
  }

  async upsertCatalogEntry(entry: RiskCatalogEntry): Promise<RiskCatalogEntry> {
    if (!entry.id) entry = { ...entry, id: randomUUID() };
    const saved = await this.catalog.upsert(entry);
    await this.refreshActiveCatalog();
    await this.audit.record({ action: "source.config", detail: { catalogUpsert: saved.id } });
    return saved;
  }

  async deleteCatalogEntry(id: string): Promise<boolean> {
    const ok = await this.catalog.remove(id);
    if (ok) {
      await this.refreshActiveCatalog();
      await this.audit.record({ action: "source.config", detail: { catalogDelete: id } });
    }
    return ok;
  }

  async setCatalogEntryEnabled(id: string, enabled: boolean): Promise<RiskCatalogEntry | null> {
    const all = await this.catalog.list();
    const entry = all.find((r) => r.id === id);
    if (!entry) return null;
    const saved = await this.catalog.upsert({ ...entry, enabled });
    await this.refreshActiveCatalog();
    await this.audit.record({ action: "source.config", detail: { catalogEnable: id, enabled } });
    return saved;
  }

  /** Export the full catalog as a plain object (for JSON download). */
  async exportCatalog(): Promise<{ risks: RiskCatalogEntry[] }> {
    return { risks: await this.catalog.list() };
  }

  /**
   * Import catalog entries. mode "replace" swaps the whole catalog; "merge"
   * upserts by id (default). Accepts either a {risks:[...]} object or a bare array.
   */
  async importCatalog(
    data: { risks?: RiskCatalogEntry[] } | RiskCatalogEntry[],
    mode: "merge" | "replace" = "merge",
  ): Promise<number> {
    const risks = Array.isArray(data) ? data : data.risks ?? [];
    const valid = risks.filter((r) => r && r.id && r.name);
    if (mode === "replace") {
      await this.catalog.replaceAll(valid);
    } else {
      for (const r of valid) await this.catalog.upsert(r);
    }
    await this.refreshActiveCatalog();
    await this.audit.record({ action: "source.config", detail: { catalogImport: valid.length, mode } });
    return valid.length;
  }

  /** Recent audit-log entries (most-recent last). */
  async auditTail(limit = 100): Promise<AuditEntry[]> {
    return this.audit.tail(limit);
  }

  // --- chat ----------------------------------------------------------------

  /** True if an LLM provider is configured (chat requires one). */
  async chatAvailable(): Promise<boolean> {
    return (await createChatModelFromEnv()) !== null;
  }

  private async ensureChatAgent(): Promise<ReturnType<typeof buildChatAgent>> {
    if (this.chatAgent) return this.chatAgent;
    const model = await createChatModelFromEnv();
    if (!model) {
      throw new Error(
        "No LLM provider configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY, " +
          "or PS_AGENT_LLM_PROVIDER=ollama with PS_AGENT_LLM_MODEL.",
      );
    }
    // Persist chat threads in MongoDB when the mongo backend is active.
    const checkpointer = await createCheckpointer();
    this.chatAgent = buildChatAgent({ model, service: this, checkpointer });
    return this.chatAgent;
  }

  /** Run one chat turn (blocking). threadId scopes conversation memory. */
  async chat(threadId: string, message: string): Promise<ChatResult> {
    const agent = await this.ensureChatAgent();
    return runChatTurn(agent, threadId, message);
  }

  /** Stream a chat turn as events (tool_call / reply). */
  async *chatStream(threadId: string, message: string): AsyncGenerator<ChatStreamEvent> {
    const agent = await this.ensureChatAgent();
    yield* streamChatTurn(agent, threadId, message);
  }

  // --- sources -------------------------------------------------------------

  async listSources(): Promise<Source[]> {
    return (await this.sources.list()).map(redactSource);
  }

  /** Unredacted source list — for internal consumers (e.g. the scheduler). */
  async listSourcesRaw(): Promise<Source[]> {
    return this.sources.list();
  }

  async registerSource(input: RegisterSourceInput): Promise<Source> {
    // Primary kind is the collection method. An attached `atlas` key on a
    // direct/MCP source is only for trends/capacity, so connectionString/mcp
    // take precedence when deciding the kind.
    const kind =
      input.kind ??
      (input.connectionString
        ? "direct"
        : input.mcp
          ? "mcp"
          : input.atlas
            ? "atlas"
            : input.opsManager
              ? "opsmanager"
              : "direct");
    const source: Source = {
      id: randomUUID(),
      name: input.name,
      kind,
      connectionString: input.connectionString,
      atlas: input.atlas,
      mcp: input.mcp,
      opsManager: input.opsManager,
      tags: input.tags,
    };
    const saved = await this.sources.upsert(source);
    await this.audit.record({
      action: "source.register",
      sourceId: saved.id,
      detail: { name: saved.name, kind: saved.kind },
    });
    return redactSource(saved);
  }

  /**
   * Import a getMongoData.js log (for isolated clusters the agent can't reach).
   * Parses the export into facts, creates/updates an `offline` source, runs the
   * rule engine, and persists a scan snapshot. If `sourceId` is given, updates
   * that existing offline source; otherwise registers a new one.
   */
  async importGetMongoData(
    raw: string,
    opts: { name?: string; sourceId?: string } = {},
  ): Promise<ScanResult> {
    const parsed = parseGetMongoData(raw); // throws on invalid JSON/shape
    let source: Source | null = opts.sourceId ? await this.sources.get(opts.sourceId) : null;
    if (!source) {
      source = {
        id: opts.sourceId ?? randomUUID(),
        name: opts.name ?? parsed.host ?? "offline-import",
        kind: "offline",
      };
      await this.sources.upsert(source);
      await this.audit.record({
        action: "source.register",
        sourceId: source.id,
        detail: { name: source.name, kind: "offline" },
      });
    }
    const facts = {
      ...parsed.facts,
      sourceId: source.id,
      sourceName: source.name,
    };
    const scan = scoreFactsToScan(source, facts);
    await this.scans.saveScan(scan);
    await this.audit.record({
      action: "scan.run",
      sourceId: source.id,
      detail: { score: scan.score.value, findings: scan.findings.length, offline: true },
    });
    return scan;
  }

  /**
   * Import an mdiag.sh export (OS/kernel tunings Linux clusters). It enriches an
   * EXISTING source's latest scan with OS facts (swappiness, THP, read-ahead,
   * ulimits, SELinux, NUMA, …) and re-scores so OS-tuning register risks can
   * fire. If no sourceId is given, creates a standalone offline source from the
   * OS facts alone.
   */
  async importMdiag(
    raw: string,
    opts: { name?: string; sourceId?: string } = {},
  ): Promise<ScanResult> {
    const os = parseMdiag(raw); // throws on invalid JSON/shape

    // Enrich an existing source. Prefer layering OS facts onto the latest scan;
    // if the source has no scan yet, bootstrap a minimal one (no hard dependency
    // on importing getMongoData first).
    if (opts.sourceId) {
      const source = await this.sources.get(opts.sourceId);
      if (!source) throw new Error(`Source ${opts.sourceId} not found`);
      const metas = await this.scans.listScans(opts.sourceId);
      const latest = metas[0] ? await this.scans.getScan(metas[0].id) : null;
      const facts = latest
        ? { ...latest.facts, os }
        : {
            sourceId: source.id,
            sourceName: source.name,
            collectedAt: new Date(),
            topology: { type: "standalone" as const, mongoVersion: "unknown", nodeCount: 1 },
            os,
            collectionMethod: "offline" as const,
            warnings: ["mdiag attached before any MongoDB snapshot: OS/kernel facts only."],
          };
      const scan = scoreFactsToScan(source, facts);
      await this.scans.saveScan(scan);
      await this.audit.record({
        action: "scan.run",
        sourceId: source.id,
        detail: { mdiag: true, score: scan.score.value, findings: scan.findings.length },
      });
      return scan;
    }

    // Standalone: a new offline source carrying only OS facts.
    const source: Source = {
      id: randomUUID(),
      name: opts.name ?? os.mdiagRef ?? "mdiag-import",
      kind: "offline",
    };
    await this.sources.upsert(source);
    await this.audit.record({
      action: "source.register",
      sourceId: source.id,
      detail: { name: source.name, kind: "offline", mdiag: true },
    });
    const facts = {
      sourceId: source.id,
      sourceName: source.name,
      collectedAt: new Date(),
      topology: { type: "standalone" as const, mongoVersion: "unknown", nodeCount: 1 },
      os,
      collectionMethod: "offline" as const,
      warnings: ["mdiag-only import: OS/kernel facts only (no MongoDB serverStatus)."],
    };
    const scan = scoreFactsToScan(source, facts);
    await this.scans.saveScan(scan);
    return scan;
  }

  /**
   * Import MongoDB FTDC (`diagnostic.data/metrics.*`) binary archive files. This
   * is the OFFLINE equivalent of the Atlas/OpsManager metrics API: FTDC is the
   * only way to obtain real CPU/memory/disk/IOPS trends from a network-isolated
   * cluster. It produces both:
   *   - a scan + health score (from the embedded serverStatus/hostInfo snapshot), and
   *   - time-series metrics (CACHE_USED_BYTES, SYSTEM_NORMALIZED_CPU_*,
   *     DISK_PARTITION_SPACE_*, DISK_PARTITION_IOPS_TOTAL, opcounters), so the
   *     capacity engine works for offline sources.
   *
   * With `sourceId`, it ENRICHES that source (merges FTDC facts into its latest
   * scan if present, else starts a new scan) and appends the series to it —
   * useful to attach FTDC to a getMongoData-imported cluster. Otherwise it
   * creates a standalone offline source. Metric appends are idempotent, so
   * re-importing overlapping files is safe.
   */
  async importFtdc(
    buffers: Buffer | Buffer[],
    opts: { name?: string; sourceId?: string; input?: string } = {},
  ): Promise<ScanResult & { metricPointsAdded: number; seriesCount: number }> {
    const parsed = parseFtdc(buffers); // throws if no decodable chunks

    let source: Source | null = opts.sourceId ? await this.sources.get(opts.sourceId) : null;
    const isNew = !source;
    if (!source) {
      source = {
        id: opts.sourceId ?? randomUUID(),
        name: opts.name ?? parsed.host ?? "ftdc-import",
        kind: "offline",
      };
      await this.sources.upsert(source);
      await this.audit.record({
        action: "source.register",
        sourceId: source.id,
        detail: { name: source.name, kind: "offline", ftdc: true },
      });
    }

    // Build facts: when enriching an existing scan, keep its richer facts
    // (topology/replset/storage from getMongoData) and only layer in whatever
    // FTDC adds (hostInfo, fresh serverStatus/version).
    let facts;
    if (!isNew) {
      const metas = await this.scans.listScans(source.id);
      const latest = metas[0] ? await this.scans.getScan(metas[0].id) : null;
      facts = latest
        ? {
            ...latest.facts,
            hostInfo: latest.facts.hostInfo ?? parsed.facts.hostInfo,
            serverStatus: latest.facts.serverStatus ?? parsed.facts.serverStatus,
            warnings: [...(latest.facts.warnings ?? []), ...parsed.facts.warnings],
            sourceId: source.id,
            sourceName: source.name,
          }
        : { ...parsed.facts, sourceId: source.id, sourceName: source.name };
    } else {
      facts = { ...parsed.facts, sourceId: source.id, sourceName: source.name };
    }

    const scan = scoreFactsToScan(source, facts);
    await this.scans.saveScan(scan);

    // Feed the time-series store so capacity analysis works offline.
    let metricPointsAdded = 0;
    for (const s of parsed.series) {
      metricPointsAdded += await this.metrics.appendPoints(
        source.id,
        s.processId,
        s.metric,
        s.units,
        s.points,
      );
    }

    // Record FTDC provenance (single-file upload) — metadata only, no raw bytes.
    const nodeRange = new Map<string, { from: number; to: number }>();
    if (parsed.host && parsed.firstTs != null && parsed.lastTs != null) {
      nodeRange.set(parsed.host, { from: parsed.firstTs, to: parsed.lastTs });
    }
    source = {
      ...source,
      ftdcProvenance: mergeFtdcProvenance(source.ftdcProvenance, {
        input: opts.input,
        filesProcessed: 1,
        nodes: parsed.host ? [parsed.host] : [],
        metricPointsAdded,
        from: parsed.firstTs,
        to: parsed.lastTs,
        nodeRange,
      }),
    };
    await this.sources.upsert(source);

    await this.audit.record({
      action: "scan.run",
      sourceId: source.id,
      detail: {
        ftdc: true,
        score: scan.score.value,
        findings: scan.findings.length,
        samples: parsed.sampleCount,
        series: parsed.series.length,
        metricPointsAdded,
      },
    });

    return { ...scan, metricPointsAdded, seriesCount: parsed.series.length };
  }

  /**
   * Stream-import FTDC from a list of file paths (e.g. every `metrics.*` under
   * one or more `diagnostic.data` directories, across multiple nodes). Files are
   * read, decoded, and their series appended ONE AT A TIME, freeing each buffer
   * before the next — so a multi-GB, multi-node import stays within bounded
   * memory. The raw files are NOT copied into the store; only the extracted,
   * downsampled series are kept (a few MB/node vs GB of raw FTDC).
   *
   * All nodes map to a SINGLE offline source (the cluster); each node keeps its
   * own `processId` (host:port) series, and capacity rolls up across nodes via
   * the store's busiest-node aggregation. Facts come from the richest snapshot
   * seen (the file whose metadata has the most hostInfo/version detail).
   */
  async importFtdcFiles(
    filePaths: string[],
    opts: { name?: string; sourceId?: string; input?: string } = {},
  ): Promise<ScanResult & { metricPointsAdded: number; seriesCount: number; filesProcessed: number; nodes: string[] }> {
    if (filePaths.length === 0) throw new Error("No FTDC files provided.");
    const { readFile } = await import("node:fs/promises");

    // Resolve/create the single cluster source up front.
    let source: Source | null = opts.sourceId ? await this.sources.get(opts.sourceId) : null;
    const isNew = !source;

    let bestFacts: Omit<CollectedFacts, "sourceId" | "sourceName"> | null = null;
    let bestHost: string | undefined;
    let metricPointsAdded = 0;
    const seriesKeys = new Set<string>();
    const nodes = new Set<string>();
    let filesProcessed = 0;
    const warnings: string[] = [];
    // Per-node coverage [from, to] (ms) seen in THIS import batch.
    const nodeRange = new Map<string, { from: number; to: number }>();
    let batchFrom = Infinity;
    let batchTo = -Infinity;

    for (const path of filePaths) {
      let parsed;
      try {
        const buf = await readFile(path); // one file in memory at a time
        parsed = parseFtdc(buf); // buf is released after this scope iteration
      } catch (err) {
        warnings.push(`FTDC: skipped ${path}: ${(err as Error).message}`);
        continue;
      }
      filesProcessed++;
      const node = parsed.host ?? "";
      if (parsed.host) nodes.add(parsed.host);

      // Track time coverage (overall + per node).
      if (parsed.firstTs != null && parsed.lastTs != null) {
        batchFrom = Math.min(batchFrom, parsed.firstTs);
        batchTo = Math.max(batchTo, parsed.lastTs);
        const cur = nodeRange.get(node);
        nodeRange.set(node, {
          from: Math.min(cur?.from ?? Infinity, parsed.firstTs),
          to: Math.max(cur?.to ?? -Infinity, parsed.lastTs),
        });
      }

      // Lazily create the source once we know a host name (better default name).
      if (!source) {
        source = {
          id: opts.sourceId ?? randomUUID(),
          name: opts.name ?? parsed.host ?? "ftdc-import",
          kind: "offline",
        };
        await this.sources.upsert(source);
        await this.audit.record({
          action: "source.register",
          sourceId: source.id,
          detail: { name: source.name, kind: "offline", ftdc: true },
        });
      }

      // Track the richest facts snapshot (most hostInfo/version signal).
      if (!bestFacts || factsScore(parsed.facts) > factsScore(bestFacts)) {
        bestFacts = parsed.facts;
        bestHost = parsed.host;
      }

      // Append this file's per-node series immediately, then drop it.
      for (const s of parsed.series) {
        metricPointsAdded += await this.metrics.appendPoints(
          source.id,
          s.processId,
          s.metric,
          s.units,
          s.points,
        );
        seriesKeys.add(`${s.processId ?? ""}|${s.metric}`);
      }
    }

    if (!source || !bestFacts) {
      throw new Error("No decodable FTDC metric chunks found in the provided file(s).");
    }
    void bestHost;

    // Record FTDC provenance on the source (what was ingested, from where, and
    // the time range) — without storing any raw bytes.
    source = {
      ...source,
      ftdcProvenance: mergeFtdcProvenance(source.ftdcProvenance, {
        input: opts.input,
        filesProcessed,
        nodes: [...nodes],
        metricPointsAdded,
        from: Number.isFinite(batchFrom) ? batchFrom : undefined,
        to: Number.isFinite(batchTo) ? batchTo : undefined,
        nodeRange,
      }),
    };
    await this.sources.upsert(source);

    // Build the scan facts (enrich an existing source's latest scan if present).
    let facts;
    if (!isNew) {
      const metas = await this.scans.listScans(source.id);
      const latest = metas[0] ? await this.scans.getScan(metas[0].id) : null;
      facts = latest
        ? {
            ...latest.facts,
            hostInfo: latest.facts.hostInfo ?? bestFacts.hostInfo,
            serverStatus: latest.facts.serverStatus ?? bestFacts.serverStatus,
            warnings: [...(latest.facts.warnings ?? []), ...bestFacts.warnings, ...warnings],
            sourceId: source.id,
            sourceName: source.name,
          }
        : { ...bestFacts, warnings: [...bestFacts.warnings, ...warnings], sourceId: source.id, sourceName: source.name };
    } else {
      facts = { ...bestFacts, warnings: [...bestFacts.warnings, ...warnings], sourceId: source.id, sourceName: source.name };
    }

    const scan = scoreFactsToScan(source, facts);
    await this.scans.saveScan(scan);

    await this.audit.record({
      action: "scan.run",
      sourceId: source.id,
      detail: {
        ftdc: true,
        score: scan.score.value,
        findings: scan.findings.length,
        files: filesProcessed,
        nodes: nodes.size,
        series: seriesKeys.size,
        metricPointsAdded,
      },
    });

    return {
      ...scan,
      metricPointsAdded,
      seriesCount: seriesKeys.size,
      filesProcessed,
      nodes: [...nodes],
    };
  }

  /**
   * Unified diagnostic import: accept ANY mix of files (a whole folder of
   * getMongoData + mdiag + FTDC, across multiple nodes) and ingest them into a
   * SINGLE cluster source. Each file is auto-classified by content; files are
   * processed in dependency order (getMongoData first to set cluster topology,
   * then mdiag OS facts, then FTDC metrics) so enrichment layers correctly.
   *
   * Files are provided as lightweight descriptors so large FTDC can be streamed
   * from disk (`path`) rather than held in memory (`buf`). Returns a per-file
   * classification + a roll-up so the UI can show exactly what was ingested.
   */
  async importBundle(
    files: Array<{ filename: string; buf?: Buffer; path?: string }>,
    opts: { name?: string; sourceId?: string } = {},
  ): Promise<BundleImportResult> {
    if (files.length === 0) throw new Error("No files provided.");
    const { readFile } = await import("node:fs/promises");

    // Classify every file first (cheap: sniff header / small JSON peek). For
    // path-only FTDC we read a small prefix to confirm the type without loading
    // the whole (possibly GB) file.
    const classified: Array<{
      filename: string;
      buf?: Buffer;
      path?: string;
      kind: DiagnosticKind;
      reason: string;
    }> = [];
    for (const f of files) {
      let head = f.buf;
      if (!head && f.path) {
        // Peek the first 4 KiB: enough to tell binary FTDC from JSON without
        // loading a multi-GB file. JSON files are read fully below for parsing.
        head = await readHead(f.path, 4 * 1024);
      }
      if (!head) {
        classified.push({ ...f, kind: "unknown", reason: "no content" });
        continue;
      }
      let det = detectDiagnostic(head, f.filename);
      // A JSON file needs the full content to classify by section vocabulary; the
      // 4 KiB peek can be inconclusive ("unknown" JSON). Re-classify from the
      // whole file (JSON diagnostics are small; FTDC is never fully read here).
      if (det.kind === "unknown" && f.path && looksLikeJsonPrefix(head)) {
        try {
          const full = await readFile(f.path);
          det = detectDiagnostic(full, f.filename);
        } catch {
          /* keep unknown */
        }
      }
      classified.push({ ...f, kind: det.kind, reason: det.reason });
    }

    const perFile = classified.map((c) => ({ filename: c.filename, kind: c.kind, reason: c.reason }));
    const gmd = classified.filter((c) => c.kind === "getMongoData");
    const mdiag = classified.filter((c) => c.kind === "mdiag");
    const ftdc = classified.filter((c) => c.kind === "ftdc");
    const unknown = classified.filter((c) => c.kind === "unknown");

    if (gmd.length + mdiag.length + ftdc.length === 0) {
      throw new Error(
        "None of the files were recognized as getMongoData, mdiag, or FTDC diagnostics.",
      );
    }

    const warnings: string[] = [];
    // Reconciler collapses FTDC "host:port", mdiag bare hostnames, and
    // getMongoData member names onto one canonical name per physical node.
    const reconciler = createNodeReconciler();
    let sourceId = opts.sourceId;
    let lastScan: ScanResult | null = null;

    // --- 1) getMongoData: establishes/updates the cluster source + topology ---
    for (const c of gmd) {
      try {
        const raw = (c.buf ?? (await readFile(c.path!))).toString("utf8");
        const scan = await this.importGetMongoData(raw, { name: opts.name, sourceId });
        sourceId = scan.sourceId;
        lastScan = scan;
        // Seed the roster from replica-set membership — the authoritative node list.
        reconciler.seedRoster((scan.facts.replSetStatus?.members ?? []).map((m) => m.name));
        if (scan.facts.hostInfo?.hostname) reconciler.add(scan.facts.hostInfo.hostname);
      } catch (err) {
        warnings.push(`getMongoData ${c.filename}: ${(err as Error).message}`);
      }
    }

    // If no getMongoData but we have mdiag/ftdc, make sure a source exists so the
    // node-level data has somewhere to land.
    if (!sourceId && (mdiag.length || ftdc.length)) {
      const source: Source = {
        id: randomUUID(),
        name: opts.name ?? "diagnostic-import",
        kind: "offline",
      };
      await this.sources.upsert(source);
      await this.audit.record({
        action: "source.register",
        sourceId: source.id,
        detail: { name: source.name, kind: "offline", bundle: true },
      });
      sourceId = source.id;
    }

    // --- 2) mdiag: per-node OS facts (merged onto the cluster scan) ---
    for (const c of mdiag) {
      try {
        const raw = (c.buf ?? (await readFile(c.path!))).toString("utf8");
        const scan = await this.importMdiag(raw, { sourceId });
        sourceId = scan.sourceId;
        lastScan = scan;
        if (scan.facts.os?.hostname) reconciler.add(scan.facts.os.hostname);
      } catch (err) {
        warnings.push(`mdiag ${c.filename}: ${(err as Error).message}`);
      }
    }

    // --- 3) FTDC: per-node metrics. Stream path-based files; buffer the rest ---
    let metricPointsAdded = 0;
    let seriesCount = 0;
    const ftdcPaths = ftdc.filter((c) => c.path).map((c) => c.path!);
    const ftdcBufs = ftdc.filter((c) => !c.path && c.buf);
    if (ftdcPaths.length) {
      try {
        const r = await this.importFtdcFiles(ftdcPaths, { name: opts.name, sourceId, input: "bundle" });
        sourceId = r.sourceId;
        lastScan = r;
        metricPointsAdded += r.metricPointsAdded;
        seriesCount = Math.max(seriesCount, r.seriesCount);
        for (const n of r.nodes) reconciler.add(n);
      } catch (err) {
        warnings.push(`FTDC (streamed): ${(err as Error).message}`);
      }
    }
    for (const c of ftdcBufs) {
      try {
        const r = await this.importFtdc(c.buf!, { name: opts.name, sourceId, input: c.filename });
        sourceId = r.sourceId;
        lastScan = r;
        metricPointsAdded += r.metricPointsAdded;
        seriesCount = Math.max(seriesCount, r.seriesCount);
      } catch (err) {
        warnings.push(`FTDC ${c.filename}: ${(err as Error).message}`);
      }
    }

    if (!sourceId || !lastScan) {
      throw new Error("Nothing could be imported from the provided files.");
    }

    return {
      sourceId,
      sourceName: lastScan.sourceName,
      score: lastScan.score.value,
      counts: {
        getMongoData: gmd.length,
        mdiag: mdiag.length,
        ftdc: ftdc.length,
        unknown: unknown.length,
      },
      nodes: reconciler.list(),
      metricPointsAdded,
      seriesCount,
      perFile,
      warnings,
    };
  }

  async removeSource(id: string): Promise<boolean> {
    const ok = await this.sources.remove(id);
    if (ok) {
      await this.metrics.removeSource(id).catch(() => undefined);
      await this.audit.record({ action: "source.remove", sourceId: id });
    }
    return ok;
  }

  /** Read a stored metric series for a source (for capacity/trend analysis). */
  async getMetricSeries(
    sourceId: string,
    metric: string,
    opts?: { processId?: string; since?: Date },
  ): Promise<Array<{ ts: Date; value: number }>> {
    return this.metrics.getSeries(sourceId, metric, opts);
  }

  /** Distinct metric names stored for a source. */
  async listMetricSeries(sourceId: string): Promise<string[]> {
    return this.metrics.listMetrics(sourceId);
  }

  /**
   * Compute a capacity report (growth, utilization, scale recommendation) from
   * the stored metric history + the latest scan's cluster spec. Deterministic;
   * the LLM only narrates it later.
   */
  async getCapacityReport(sourceId: string): Promise<CapacityReport> {
    const windowDays = numEnvDays();
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const source = await this.sources.get(sourceId);
    // Cluster spec from the most recent scan (Atlas-kind sources carry it in facts).
    let spec: ClusterSpec | undefined;
    const metas = await this.scans.listScans(sourceId);
    if (metas[0]) {
      const scan = await this.scans.getScan(metas[0].id);
      spec = scan?.facts.atlas?.clusterSpec;
    }
    // Direct/MCP sources that attached an Atlas key for trends won't have the
    // spec in their scan facts (they scanned via the driver/MCP). Fetch it live
    // so utilization has real limits instead of "unknown".
    if (!spec && source?.atlas) {
      try {
        spec = (await new AtlasCollector(source).collectClusterSpec()) ?? undefined;
      } catch {
        /* non-fatal; falls back to unbounded */
      }
    }
    // Offline / direct (self-managed) sources have no cluster tier, but the
    // hostInfo (RAM/cores) from getMongoData / hostInfo gives real limits.
    if (!spec && metas[0]) {
      const scan = await this.scans.getScan(metas[0].id);
      const hi = scan?.facts.hostInfo;
      if (hi && (hi.memSizeMB || hi.cpuCores)) {
        spec = {
          instanceSize: undefined,
          ramGB: hi.memSizeMB ? hi.memSizeMB / 1024 : undefined,
          vcpus: hi.cpuCores,
        };
      }
    }
    // Slow-query signals for query-bottleneck analysis (Atlas creds — possibly
    // attached to a direct/MCP source for trends — or an Ops Manager source).
    let querySignals: QuerySignal[] | undefined;
    if (source?.atlas || source?.opsManager) {
      try {
        const warnings: string[] = [];
        const lines = source.opsManager
          ? await new OpsManagerCollector(source).collectSlowQueryLines(warnings)
          : await new AtlasCollector(source).collectSlowQueryLines(warnings);
        querySignals = aggregateSlowQueries(lines);
      } catch {
        /* non-fatal */
      }
    }
    return computeCapacityReport({
      spec,
      windowDays,
      querySignals,
      getSeries: (metric) => this.metrics.getSeries(sourceId, metric, { since }),
    });
  }

  /**
   * Assess a cluster against the expert risk register (risks-catalog.json).
   * Deterministic evaluators mark risks detected/clear/unknown; remaining risks
   * are "manual", and (if an LLM is configured) cross-referenced as advisory
   * "suggested" matches. Uses the most recent scan's facts.
   */
  async getRiskReport(sourceId: string): Promise<RiskReport> {
    const metas = await this.scans.listScans(sourceId);
    const scan = metas[0] ? await this.scans.getScan(metas[0].id) : null;
    if (!scan) {
      throw new Error("No scan available for this source. Scan or import it first.");
    }
    // Only enabled risks are assessed (disabled ones are skipped entirely).
    const catalog = (await this.catalog.list()).filter((r) => r.enabled !== false);
    const assessments: RiskAssessment[] = evaluateRisks(catalog, scan.facts);

    // LLM-assisted matching for the "manual" risks (advisory, best-effort).
    const manual = assessments.filter((a) => a.status === "manual");
    const model = await createChatModelFromEnv();
    if (model && manual.length > 0) {
      try {
        const cfg = llmConfigFromEnv();
        const matched = await matchRisksWithLlm(
          model,
          cfg?.provider,
          scan.facts,
          manual.map((a) => a.risk),
        );
        for (const a of assessments) {
          const hit = matched.get(a.risk.id);
          if (hit) {
            a.status = "suggested";
            a.detail = hit.rationale;
            a.confidence = hit.confidence;
          }
        }
      } catch {
        /* advisory layer is best-effort */
      }
    }

    const counts = { detected: 0, clear: 0, manual: 0, suggested: 0, unknown: 0 };
    for (const a of assessments) counts[a.status]++;

    return {
      generatedAt: new Date().toISOString(),
      sourceId,
      counts,
      assessments: assessments.sort((a, b) => rankRisk(a) - rankRisk(b)),
    };
  }

  /**
   * Update a source's schedule and/or threshold overrides. Returns the
   * redacted updated source, or null if not found.
   */
  async updateSourceConfig(
    id: string,
    config: { schedule?: Source["schedule"]; thresholdOverrides?: Source["thresholdOverrides"] },
  ): Promise<Source | null> {
    const source = await this.sources.get(id);
    if (!source) return null;
    const updated: Source = {
      ...source,
      schedule: config.schedule ?? source.schedule,
      thresholdOverrides: config.thresholdOverrides ?? source.thresholdOverrides,
    };
    const saved = await this.sources.upsert(updated);
    await this.audit.record({
      action: "source.config",
      sourceId: id,
      detail: {
        schedule: saved.schedule,
        thresholdOverrides: saved.thresholdOverrides,
      },
    });
    return redactSource(saved);
  }

  // --- scans ---------------------------------------------------------------

  /** Run a scan for a registered source and persist the snapshot. */
  async scanSource(
    id: string,
    summarize = false,
    opts: { emitEvents?: boolean } = {},
  ): Promise<ScanResult> {
    const source = await this.sources.get(id);
    if (!source) throw new Error(`Source ${id} not found`);
    // Offline sources can't be collected live — re-score the last import instead.
    if (source.kind === "offline") {
      const metas = await this.scans.listScans(id);
      const latest = metas[0] ? await this.scans.getScan(metas[0].id) : null;
      if (!latest) {
        throw new Error("No imported data for this offline source. Import a getMongoData log first.");
      }
      return scoreFactsToScan(source, latest.facts);
    }
    const result = await runGraphScan(source, {
      summarize,
      store: this.scans,
      emitEvents: opts.emitEvents,
    });
    await this.audit.record({
      action: "scan.run",
      sourceId: id,
      detail: { score: result.score.value, findings: result.findings.length, summarize },
    });
    // Collect + persist historical metric series for capacity/trend analysis
    // (Atlas only for now). Never let this fail the scan.
    void this.collectAndStoreHistory(source).catch(() => undefined);
    return result;
  }

  /**
   * Pull historical metric series (Atlas) and append them to the metric store.
   * Runs out-of-band so it doesn't slow the scan response. Appends are
   * idempotent, so backfilling the same window repeatedly is safe.
   */
  private async collectAndStoreHistory(source: Source): Promise<void> {
    // History/capacity needs an API source: Atlas credentials (incl. a direct/MCP
    // source that attached an Atlas key for trends) or Ops Manager.
    if (!source.atlas && !source.opsManager) return;
    const warnings: string[] = [];
    const series = source.opsManager
      ? await new OpsManagerCollector(source).collectHistory(warnings)
      : await new AtlasCollector(source).collectHistory(warnings);
    for (const s of series) {
      await this.metrics.appendPoints(s.sourceId, s.processId, s.metric, s.units, s.points);
    }
    if (warnings.length > 0) {
      await this.audit.record({
        action: "scan.run",
        sourceId: source.id,
        detail: { historyWarnings: warnings.slice(0, 5), seriesStored: series.length },
      });
    }
  }

  async listScans(sourceId?: string): Promise<ScanSnapshotMeta[]> {
    return this.scans.listScans(sourceId);
  }

  async getScan(scanId: string): Promise<ScanResult | null> {
    return this.scans.getScan(scanId);
  }

  /** Latest scan per source — the data the fleet overview renders from. */
  async fleetOverview(): Promise<FleetEntry[]> {
    const sources = await this.sources.list();
    const entries: FleetEntry[] = [];
    for (const s of sources) {
      const scans = await this.scans.listScans(s.id);
      const latest = scans[0];
      // Load the full scan to get the structured score (with counts) for pills.
      const full = latest ? await this.scans.getScan(latest.id) : null;
      entries.push({
        source: redactSource(s),
        latestScanId: latest?.id,
        score: full?.score,
        lastScannedAt: latest?.finishedAt,
      });
    }
    return entries;
  }

  /** Cross-fleet findings sorted worst-first — the risk inbox. */
  async riskInbox(): Promise<RiskInboxItem[]> {
    const sources = await this.sources.list();
    const items: RiskInboxItem[] = [];
    for (const s of sources) {
      const metas = await this.scans.listScans(s.id);
      const latest = metas[0];
      if (!latest) continue;
      const scan = await this.scans.getScan(latest.id);
      if (!scan) continue;
      for (const f of scan.findings) {
        items.push({
          sourceId: s.id,
          sourceName: s.name,
          scanId: latest.id,
          checkId: f.checkId,
          category: f.category,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          evidence: f.evidence,
          remediation: f.remediation,
        });
      }
    }
    const rank = { critical: 3, warning: 2, info: 1, ok: 0 } as const;
    return items.sort((a, b) => rank[b.severity] - rank[a.severity]);
  }
}

export interface FleetEntry {
  source: Source;
  latestScanId?: string;
  score?: ScanResult["score"];
  lastScannedAt?: Date;
}

export interface RiskInboxItem {
  sourceId: string;
  sourceName: string;
  scanId: string;
  checkId: string;
  category: string;
  severity: "ok" | "info" | "warning" | "critical";
  title: string;
  detail: string;
  /** Exact numbers/namespaces that triggered the finding. */
  evidence: Record<string, unknown>;
  remediation?: string;
}
