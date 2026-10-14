import type { Collector } from "../collector.js";
import type { Source } from "../../core/source.js";
import type {
  AtlasMeasurement,
  CollectedFacts,
  MetricSeries,
  Topology,
} from "../../core/types.js";
import { DigestClient } from "../atlas/digestClient.js";
import { toSeries, summarizeMeasurement } from "../atlas/atlasCollector.js";
import { planHistory, type HistoryPlan } from "../../capacity/historyBudget.js";

/** Host-level metrics pulled as a 1h snapshot for the health checks. */
const HOST_METRICS = [
  "CONNECTIONS",
  "NORMALIZED_SYSTEM_CPU_USER",
  "NORMALIZED_SYSTEM_CPU_KERNEL",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "GLOBAL_LOCK_CURRENT_QUEUE_TOTAL",
  "TICKETS_AVAILABLE_READS",
  "TICKETS_AVAILABLE_WRITE",
];

/** Metrics pulled as history (host + disk) for capacity/trend analysis. */
const HISTORY_METRICS = [
  "NORMALIZED_SYSTEM_CPU_USER",
  "NORMALIZED_SYSTEM_CPU_KERNEL",
  "SYSTEM_MEMORY_USED",
  "CACHE_USED_BYTES",
  "CACHE_DIRTY_BYTES",
  "CONNECTIONS",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "TICKETS_AVAILABLE_READS",
  "TICKETS_AVAILABLE_WRITE",
  "GLOBAL_LOCK_CURRENT_QUEUE_TOTAL",
];

const DISK_HISTORY_METRICS = [
  "DISK_PARTITION_SPACE_USED",
  "DISK_PARTITION_SPACE_FREE",
  "DISK_PARTITION_IOPS_TOTAL",
  "DISK_PARTITION_LATENCY_READ",
  "DISK_PARTITION_LATENCY_WRITE",
];

/**
 * Collects facts from a self-managed MongoDB via Ops Manager's Public API.
 *
 * Mirrors the Atlas collector but uses OM's base URL + `/api/public/v1.0` path,
 * `application/json` Accept, and `/hosts` instead of `/processes`. Auth is the
 * same HTTP Digest ("MMS Public API" realm), so we reuse DigestClient.
 *
 * No cluster-tier spec exists for self-managed hosts, so utilization is shown
 * without hardware limits (the capacity engine marks it "unbounded").
 */
export class OpsManagerCollector implements Collector {
  private readonly client: DigestClient;
  private readonly baseUrl: string;
  private readonly projectId: string;

  constructor(
    private readonly source: Source,
    fetchImpl: typeof fetch = fetch,
  ) {
    const om = source.opsManager;
    if (!om) throw new Error(`Source ${source.id} is not an Ops Manager source`);
    this.projectId = om.projectId;
    this.baseUrl = om.baseUrl.replace(/\/+$/, "");
    this.client = new DigestClient(
      { username: om.publicKey, password: om.privateKey },
      fetchImpl,
    );
  }

  async collect(): Promise<CollectedFacts> {
    const warnings: string[] = [];
    const hosts = await this.collectHosts(warnings);

    // 1h snapshot measurements for the primary (or first) host.
    const primary = hosts.find((h) => /PRIMARY/i.test(h.typeName)) ?? hosts[0];
    let serverStatus: CollectedFacts["serverStatus"];
    let topology: Topology = { type: "standalone", mongoVersion: "unknown", nodeCount: hosts.length || 1 };

    if (primary) {
      const version = primary.version ?? "unknown";
      const setName = hosts.find((h) => h.replicaSetName)?.replicaSetName;
      topology = {
        type: hosts.some((h) => /MONGOS/i.test(h.typeName))
          ? "sharded"
          : hosts.length > 1
            ? "replicaSet"
            : "standalone",
        mongoVersion: version,
        setName,
        nodeCount: hosts.length || 1,
      };
    }

    return {
      sourceId: this.source.id,
      sourceName: this.source.name,
      collectedAt: new Date(),
      topology,
      serverStatus,
      collectionMethod: "atlas", // treated like an API-metrics source in the UI
      warnings: [
        ...warnings,
        "Ops Manager source: node-level serverStatus/replSetGetStatus checks are limited; metrics & capacity come from the OM API.",
      ],
    };
  }

  async close(): Promise<void> {
    /* stateless HTTP */
  }

  /** Historical metric series (host + disk) within a budgeted window. */
  async collectHistory(warnings: string[]): Promise<MetricSeries[]> {
    const plan = planHistory();
    for (const w of plan.warnings) warnings.push(w);
    const hosts = await this.safe(() => this.collectHosts([]), warnings, "history hosts");
    if (!hosts) return [];

    const out: MetricSeries[] = [];
    for (const h of hosts) {
      const host = await this.safe(
        () => this.collectHostHistory(h.id, plan),
        warnings,
        `history for ${h.hostname}`,
      );
      if (host) out.push(...host);
      const disks = await this.safe(
        () => this.collectDiskHistory(h.id, plan),
        warnings,
        `disk history for ${h.hostname}`,
      );
      if (disks) out.push(...disks);
    }
    return out;
  }

  /** Slow-query log lines for the primary host (query-bottleneck analysis). */
  async collectSlowQueryLines(warnings: string[]): Promise<string[]> {
    const hosts = await this.safe(() => this.collectHosts([]), warnings, "slow-query hosts");
    if (!hosts || hosts.length === 0) return [];
    const primary = hosts.find((h) => /PRIMARY/i.test(h.typeName)) ?? hosts[0]!;
    const url = this.api(
      `/groups/${this.projectId}/hosts/${encodeURIComponent(primary.id)}/performanceAdvisor/slowQueryLogs`,
    );
    const resp = await this.safe(
      () => this.client.getJson<{ slowQueries?: Array<{ line?: string }> }>(url, this.headers()),
      warnings,
      "slow-query logs",
    );
    return (resp?.slowQueries ?? []).map((q) => q.line).filter((l): l is string => typeof l === "string");
  }

  // --- collection steps ----------------------------------------------------

  private async collectHosts(warnings: string[]): Promise<OmHost[]> {
    const url = this.api(`/groups/${this.projectId}/hosts`);
    const resp = await this.safe(
      () => this.client.getJson<{ results?: any[] }>(url, this.headers()),
      warnings,
      "hosts",
    );
    return (resp?.results ?? []).map((h) => ({
      id: h.id,
      hostname: h.hostname ?? "unknown",
      port: h.port ?? 27017,
      typeName: h.typeName ?? h.replicaStateName ?? "UNKNOWN",
      version: h.version,
      replicaSetName: h.replicaSetName,
    }));
  }

  private async collectHostHistory(hostId: string, plan: HistoryPlan): Promise<MetricSeries[]> {
    const params = new URLSearchParams({ granularity: plan.granularity, period: plan.period });
    for (const m of HISTORY_METRICS) params.append("m", m);
    const url = this.api(
      `/groups/${this.projectId}/hosts/${encodeURIComponent(hostId)}/measurements?${params}`,
    );
    const resp = await this.client.getJson<{ measurements?: any[] }>(url, this.headers());
    return (resp.measurements ?? [])
      .map((m) => toSeries(this.source.id, hostId, normalizeMetricName(m)))
      .filter((s): s is MetricSeries => s !== null);
  }

  private async collectDiskHistory(hostId: string, plan: HistoryPlan): Promise<MetricSeries[]> {
    const disksUrl = this.api(`/groups/${this.projectId}/hosts/${encodeURIComponent(hostId)}/disks`);
    const disksResp = await this.client.getJson<{ results?: any[] }>(disksUrl, this.headers());
    const partitions = (disksResp.results ?? []).map((d) => d.partitionName).filter(Boolean);
    const out: MetricSeries[] = [];
    for (const part of partitions) {
      const params = new URLSearchParams({ granularity: plan.granularity, period: plan.period });
      for (const m of DISK_HISTORY_METRICS) params.append("m", m);
      const url = this.api(
        `/groups/${this.projectId}/hosts/${encodeURIComponent(hostId)}/disks/${encodeURIComponent(part)}/measurements?${params}`,
      );
      const resp = await this.client.getJson<{ measurements?: any[] }>(url, this.headers());
      for (const m of resp.measurements ?? []) {
        const s = toSeries(this.source.id, hostId, m);
        if (s) out.push(s);
      }
    }
    return out;
  }

  // --- helpers -------------------------------------------------------------

  private api(path: string): string {
    return `${this.baseUrl}/api/public/v1.0${path}`;
  }

  private headers(): Record<string, string> {
    return { Accept: "application/json" };
  }

  private async safe<T>(fn: () => Promise<T>, warnings: string[], label: string): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`Ops Manager ${label} unavailable: ${(err as Error).message}`);
      return null;
    }
  }
}

interface OmHost {
  id: string;
  hostname: string;
  port: number;
  typeName: string;
  version?: string;
  replicaSetName?: string;
}

/**
 * OM uses NORMALIZED_SYSTEM_CPU_* where Atlas uses SYSTEM_NORMALIZED_CPU_*.
 * Map OM names to the canonical names the capacity engine expects so the same
 * engine works for both.
 */
function normalizeMetricName(m: any): any {
  const map: Record<string, string> = {
    NORMALIZED_SYSTEM_CPU_USER: "SYSTEM_NORMALIZED_CPU_USER",
    NORMALIZED_SYSTEM_CPU_KERNEL: "SYSTEM_NORMALIZED_CPU_KERNEL",
  };
  if (m && typeof m.name === "string" && map[m.name]) {
    return { ...m, name: map[m.name] };
  }
  return m;
}

// Re-export to keep a single import site if needed later.
export { summarizeMeasurement as _summarize };
export type { AtlasMeasurement };
