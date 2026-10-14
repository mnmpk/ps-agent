import { randomUUID } from "node:crypto";
import type { Source } from "../core/source.js";
import type { ScanResult } from "../core/types.js";
import { runGraphScan } from "../agent/graphs/healthScanGraph.js";
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

function numEnvDays(): number {
  return DEFAULT_HISTORY.days;
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
  }) {
    const defaults = createStores();
    this.sources = overrides?.sources ?? defaults.sources;
    this.scans = overrides?.scans ?? defaults.scans;
    this.audit = overrides?.audit ?? defaults.audit;
    this.metrics = overrides?.metrics ?? defaults.metrics;
    this.storeBackend = defaults.backend;
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
