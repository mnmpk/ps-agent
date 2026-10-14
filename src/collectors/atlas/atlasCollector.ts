import type { Collector } from "../collector.js";
import type { Source } from "../../core/source.js";
import type {
  AtlasAlert,
  AtlasFacts,
  AtlasMeasurement,
  AtlasProcess,
  AtlasSuggestedIndex,
  ClusterSpec,
  CollectedFacts,
  MetricSeries,
  Topology,
} from "../../core/types.js";
import { DigestClient } from "./digestClient.js";
import { tierInfo } from "../../capacity/tierTable.js";
import { planHistory, type HistoryPlan } from "../../capacity/historyBudget.js";

/** Metrics pulled as HISTORY (time series) for capacity/trend analysis. */
const HISTORY_METRICS = [
  "SYSTEM_NORMALIZED_CPU_USER",
  "SYSTEM_NORMALIZED_CPU_KERNEL",
  "SYSTEM_MEMORY_USED",
  "CACHE_BYTES_READ_INTO",
  "CACHE_DIRTY_BYTES",
  "CACHE_USED_BYTES",
  "CONNECTIONS",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "TICKETS_AVAILABLE_READS",
  "TICKETS_AVAILABLE_WRITE",
  "GLOBAL_LOCK_CURRENT_QUEUE_TOTAL",
  "OPLOG_MASTER_TIME",
];

/** Disk measurements pulled as history (per partition). */
const DISK_HISTORY_METRICS = [
  "DISK_PARTITION_SPACE_USED",
  "DISK_PARTITION_SPACE_FREE",
  "DISK_PARTITION_IOPS_TOTAL",
  "DISK_PARTITION_LATENCY_READ",
  "DISK_PARTITION_LATENCY_WRITE",
];

const DEFAULT_BASE_URL = "https://cloud.mongodb.com";
/** Atlas Admin API resource version (Accept header). */
const API_VERSION = "2023-11-15";

/**
 * Metrics we request per process; chosen to feed the Atlas health checks.
 * Names validated against the live Atlas Admin API measurements catalog.
 * Normalized CPU metrics are scaled 0-100% per core (raw ones can exceed 100%).
 */
const PROCESS_METRICS = [
  "CONNECTIONS",
  "SYSTEM_NORMALIZED_CPU_USER",
  "SYSTEM_NORMALIZED_CPU_KERNEL",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
  "QUERY_TARGETING_SCANNED_PER_RETURNED",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "GLOBAL_LOCK_CURRENT_QUEUE_TOTAL",
  "TICKETS_AVAILABLE_READS",
  "TICKETS_AVAILABLE_WRITE",
  "OPLOG_MASTER_TIME",
];

/**
 * Collects facts from a MongoDB Atlas project via the Atlas Administration API.
 *
 * Needs an Atlas programmatic API key (public/private) with at least Project
 * Read Only on the target project. All calls are read-only.
 */
export class AtlasCollector implements Collector {
  private readonly client: DigestClient;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly clusterName?: string;

  constructor(
    private readonly source: Source,
    fetchImpl: typeof fetch = fetch,
    baseUrl: string = process.env.ATLAS_BASE_URL ?? DEFAULT_BASE_URL,
  ) {
    const atlas = source.atlas;
    if (!atlas) throw new Error(`Source ${source.id} is not an Atlas source`);
    this.projectId = atlas.projectId;
    this.clusterName = atlas.clusterName;
    this.baseUrl = baseUrl;
    this.client = new DigestClient(
      { username: atlas.publicKey, password: atlas.privateKey },
      fetchImpl,
    );
  }

  async collect(): Promise<CollectedFacts> {
    const warnings: string[] = [];

    const processes = await this.collectProcesses(warnings);
    const openAlerts = await this.safe(() => this.collectOpenAlerts(), warnings, "alerts");
    const suggestedIndexes = await this.safe(
      () => this.collectSuggestedIndexes(processes),
      warnings,
      "performance advisor",
    );
    const clusterSpec = await this.safe(() => this.collectClusterSpec(), warnings, "cluster spec");

    const atlas: AtlasFacts = {
      projectId: this.projectId,
      clusterName: this.clusterName,
      processes,
      openAlerts: openAlerts ?? [],
      suggestedIndexes: suggestedIndexes ?? [],
      clusterSpec: clusterSpec ?? undefined,
    };

    return {
      sourceId: this.source.id,
      sourceName: this.source.name,
      collectedAt: new Date(),
      topology: deriveTopology(processes),
      atlas,
      collectionMethod: "atlas",
      warnings,
    };
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to close.
  }

  // --- collection steps ----------------------------------------------------

  private async collectProcesses(warnings: string[]): Promise<AtlasProcess[]> {
    const url = this.api(`/groups/${this.projectId}/processes`);
    const resp = await this.client.getJson<{ results?: any[] }>(url, this.headers());
    let results = resp.results ?? [];
    if (this.clusterName) {
      results = results.filter((p) => matchesCluster(p, this.clusterName!));
    }

    const processes: AtlasProcess[] = [];
    for (const p of results) {
      const proc: AtlasProcess = {
        id: p.id ?? `${p.hostname}:${p.port}`,
        hostname: p.hostname ?? "unknown",
        port: p.port ?? 27017,
        typeName: p.typeName ?? "UNKNOWN",
        version: p.version ?? "0.0.0",
        replicaSetName: p.replicaSetName,
        measurements: [],
      };
      proc.measurements = await this.safe(
        () => this.collectMeasurements(proc.id),
        warnings,
        `measurements for ${proc.id}`,
      ) ?? [];
      processes.push(proc);
    }
    return processes;
  }

  private async collectMeasurements(processId: string): Promise<AtlasMeasurement[]> {
    const params = new URLSearchParams({ granularity: "PT5M", period: "PT1H" });
    for (const m of PROCESS_METRICS) params.append("m", m);
    const url = this.api(
      `/groups/${this.projectId}/processes/${encodeURIComponent(processId)}/measurements?${params}`,
    );
    const resp = await this.client.getJson<{ measurements?: any[] }>(url, this.headers());
    return (resp.measurements ?? []).map((m) => summarizeMeasurement(m));
  }

  private async collectOpenAlerts(): Promise<AtlasAlert[]> {
    const url = this.api(`/groups/${this.projectId}/alerts?status=OPEN`);
    const resp = await this.client.getJson<{ results?: any[] }>(url, this.headers());
    return (resp.results ?? []).map((a) => ({
      id: a.id,
      eventTypeName: a.eventTypeName ?? "UNKNOWN",
      status: a.status ?? "OPEN",
      created: a.created ? new Date(a.created) : undefined,
      acknowledgedUntil: a.acknowledgedUntil ? new Date(a.acknowledgedUntil) : undefined,
    }));
  }

  private async collectSuggestedIndexes(
    processes: AtlasProcess[],
  ): Promise<AtlasSuggestedIndex[]> {
    // Performance Advisor is per-process; query a primary if we can find one.
    const primary = processes.find((p) => /PRIMARY/.test(p.typeName)) ?? processes[0];
    if (!primary) return [];
    const url = this.api(
      `/groups/${this.projectId}/processes/${encodeURIComponent(primary.id)}/performanceAdvisor/suggestedIndexes`,
    );
    const resp = await this.client.getJson<{ suggestedIndexes?: any[] }>(url, this.headers());
    return (resp.suggestedIndexes ?? []).map((s) => ({
      namespace: s.namespace ?? "unknown",
      weight: s.weight ?? 0,
      keys: Array.isArray(s.index) ? s.index : [],
    }));
  }

  /** Cluster hardware spec + limits (GET /clusters/{name}), enriched with the tier table. */
  async collectClusterSpec(): Promise<ClusterSpec | undefined> {
    if (!this.clusterName) return undefined;
    const url = this.api(
      `/groups/${this.projectId}/clusters/${encodeURIComponent(this.clusterName)}`,
    );
    const c = await this.client.getJson<any>(url, this.headers());
    // Dedicated clusters: replicationSpecs[].regionConfigs[].electableSpecs.
    const region = c.replicationSpecs?.[0]?.regionConfigs?.[0] ?? {};
    const electable = region.electableSpecs ?? {};
    const instanceSize: string | undefined = electable.instanceSize ?? c.instanceSizeName;
    const info = tierInfo(instanceSize);
    const compute = region.autoScaling?.compute ?? c.autoScaling?.compute ?? {};
    const diskAuto = region.autoScaling?.diskGB ?? c.autoScaling?.diskGBEnabled;
    return {
      instanceSize,
      diskSizeGB: c.diskSizeGB ?? electable.diskSizeGB,
      diskIOPS: electable.diskIOPS ?? info?.defaultDiskIOPS,
      nodeCount: electable.nodeCount,
      ramGB: info?.ramGB,
      vcpus: info?.vcpus,
      autoScaling: {
        computeEnabled: compute.enabled,
        diskEnabled: typeof diskAuto === "object" ? diskAuto.enabled : Boolean(diskAuto),
        minInstanceSize: compute.minInstanceSize,
        maxInstanceSize: compute.maxInstanceSize,
      },
      provider: region.providerName ?? c.providerSettings?.providerName,
      regionName: region.regionName,
    };
  }

  /**
   * Collect Performance Advisor slow-query log lines for the primary process,
   * for query-bottleneck analysis. Returns raw log-line strings (parsed by the
   * capacity engine). Degrades to [] on error.
   */
  async collectSlowQueryLines(warnings: string[]): Promise<string[]> {
    const processes = await this.safe(() => this.collectProcesses([]), warnings, "slow-query processes");
    if (!processes || processes.length === 0) return [];
    const primary = processes.find((p) => /PRIMARY/.test(p.typeName)) ?? processes[0]!;
    const url = this.api(
      `/groups/${this.projectId}/processes/${encodeURIComponent(primary.id)}/performanceAdvisor/slowQueryLogs`,
    );
    const resp = await this.safe(
      () => this.client.getJson<{ slowQueries?: Array<{ line?: string }> }>(url, this.headers()),
      warnings,
      "slow-query logs",
    );
    return (resp?.slowQueries ?? [])
      .map((q) => q.line)
      .filter((l): l is string => typeof l === "string");
  }

  /**
   * Pull historical metric series (host + disk) for every process, within a
   * budgeted window. Returns typed series ready to persist. The budget plan's
   * warnings (coarsening/shortening) are appended to `warnings`.
   */
  async collectHistory(warnings: string[]): Promise<MetricSeries[]> {
    const plan = planHistory();
    for (const w of plan.warnings) warnings.push(w);

    const processes = await this.safe(() => this.collectProcesses([]), warnings, "history processes");
    if (!processes) return [];

    const out: MetricSeries[] = [];
    for (const p of processes) {
      const host = await this.safe(
        () => this.collectProcessHistory(p.id, plan),
        warnings,
        `history for ${p.id}`,
      );
      if (host) out.push(...host);
      const disks = await this.safe(
        () => this.collectDiskHistory(p.id, plan),
        warnings,
        `disk history for ${p.id}`,
      );
      if (disks) out.push(...disks);
    }
    return out;
  }

  private async collectProcessHistory(processId: string, plan: HistoryPlan): Promise<MetricSeries[]> {
    const params = new URLSearchParams({ granularity: plan.granularity, period: plan.period });
    for (const m of HISTORY_METRICS) params.append("m", m);
    const url = this.api(
      `/groups/${this.projectId}/processes/${encodeURIComponent(processId)}/measurements?${params}`,
    );
    const resp = await this.client.getJson<{ measurements?: any[] }>(url, this.headers());
    return (resp.measurements ?? [])
      .map((m) => toSeries(this.source.id, processId, m))
      .filter((s): s is MetricSeries => s !== null);
  }

  private async collectDiskHistory(processId: string, plan: HistoryPlan): Promise<MetricSeries[]> {
    // Discover partitions, then pull disk metrics for each.
    const disksUrl = this.api(
      `/groups/${this.projectId}/processes/${encodeURIComponent(processId)}/disks`,
    );
    const disksResp = await this.client.getJson<{ results?: any[] }>(disksUrl, this.headers());
    const partitions = (disksResp.results ?? []).map((d) => d.partitionName).filter(Boolean);
    const out: MetricSeries[] = [];
    for (const part of partitions) {
      const params = new URLSearchParams({ granularity: plan.granularity, period: plan.period });
      for (const m of DISK_HISTORY_METRICS) params.append("m", m);
      const url = this.api(
        `/groups/${this.projectId}/processes/${encodeURIComponent(processId)}/disks/${encodeURIComponent(part)}/measurements?${params}`,
      );
      const resp = await this.client.getJson<{ measurements?: any[] }>(url, this.headers());
      for (const m of resp.measurements ?? []) {
        const s = toSeries(this.source.id, processId, m);
        if (s) out.push(s);
      }
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------

  private api(path: string): string {
    return `${this.baseUrl}/api/atlas/v2${path}`;
  }

  private headers(): Record<string, string> {
    return { Accept: `application/vnd.atlas.${API_VERSION}+json` };
  }

  /** Run a step, converting failure into a warning and returning null. */
  private async safe<T>(
    fn: () => Promise<T>,
    warnings: string[],
    label: string,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`Atlas ${label} unavailable: ${(err as Error).message}`);
      return null;
    }
  }
}

// --- pure helpers (exported for testing) -----------------------------------

/** Convert an Atlas measurement (name/units/dataPoints[]) into a MetricSeries. */
export function toSeries(
  sourceId: string,
  processId: string,
  m: any,
): MetricSeries | null {
  const raw: Array<{ timestamp?: string; value: number | null }> = m.dataPoints ?? [];
  const points = raw
    .filter((p) => typeof p.value === "number" && p.timestamp)
    .map((p) => ({ ts: new Date(p.timestamp as string), value: p.value as number }));
  if (points.length === 0) return null;
  return {
    sourceId,
    processId,
    metric: m.name ?? "UNKNOWN",
    units: m.units ?? "",
    points,
  };
}

export function summarizeMeasurement(m: any): AtlasMeasurement {
  const points: Array<{ value: number | null }> = m.dataPoints ?? [];
  const values = points
    .map((p) => p.value)
    .filter((v): v is number => typeof v === "number");
  const latest = [...points].reverse().find((p) => typeof p.value === "number")?.value;
  const average =
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  const max = values.length > 0 ? Math.max(...values) : undefined;
  return {
    name: m.name ?? "UNKNOWN",
    units: m.units ?? "",
    latest: typeof latest === "number" ? latest : undefined,
    average,
    max,
    dataPointCount: values.length,
  };
}

export function deriveTopology(processes: AtlasProcess[]): Topology {
  const hasMongos = processes.some((p) => /MONGOS/.test(p.typeName));
  const version = processes[0]?.version ?? "0.0.0";
  const setName = processes.find((p) => p.replicaSetName)?.replicaSetName;
  if (hasMongos) {
    return { type: "sharded", mongoVersion: version, nodeCount: processes.length };
  }
  return {
    type: processes.length > 1 ? "replicaSet" : "standalone",
    mongoVersion: version,
    setName,
    nodeCount: processes.length,
  };
}

function matchesCluster(process: any, clusterName: string): boolean {
  const rs: string | undefined = process.replicaSetName;
  const uid: string | undefined = process.userAlias ?? process.id;
  return (
    rs?.includes(clusterName) === true ||
    uid?.includes(clusterName) === true ||
    process.hostname?.includes(clusterName) === true
  );
}
