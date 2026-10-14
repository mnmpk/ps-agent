import type { ClusterSpec, MetricPoint } from "../core/types.js";
import { ewma, latest, linearTrend, percentile } from "./stats.js";
import { nextTierDown, nextTierUp } from "./tierTable.js";
import { querySeverity } from "./slowQuery.js";
import type {
  BottleneckSignal,
  CapacityReport,
  GrowthAnalysis,
  QuerySignal,
  ResourceUtilization,
  ScaleRecommendation,
} from "./types.js";

/** Target peak utilization we aim to keep resources under. */
const TARGET_UTIL = 0.7;
/** Below this p95 utilization (with low growth), a resource is "underutilized". */
const UNDERUTILIZED_P95 = 0.4;
/** Minimum points / span for a trustworthy trend. */
const MIN_POINTS = 6;
const MIN_SPAN_DAYS = 2;

export type SeriesFetcher = (metric: string) => Promise<MetricPoint[]>;

export interface CapacityInput {
  getSeries: SeriesFetcher;
  spec?: ClusterSpec;
  windowDays: number;
  /** Pre-aggregated slow-query signals (from Performance Advisor logs). */
  querySignals?: QuerySignal[];
}

/**
 * Compute a deterministic CapacityReport from stored metric series + cluster
 * spec. Pure-ish (only reads series via the fetcher). All numbers come from the
 * data; the LLM only narrates the result later.
 */
export async function computeCapacityReport(input: CapacityInput): Promise<CapacityReport> {
  const notes: string[] = [];
  const hasLimits = Boolean(
    input.spec && (input.spec.diskSizeGB || input.spec.ramGB || input.spec.vcpus),
  );
  if (!hasLimits) {
    notes.push(
      "Cluster size/limits unknown (no Atlas cluster spec). Utilization shown without limits; add an Atlas API key + cluster name for full capacity analysis.",
    );
  }

  const growth = await computeGrowth(input, notes);
  const utilization = await computeUtilization(input, notes);
  const bottlenecks = rankBottlenecks(utilization, growth, input.querySignals ?? []);
  const scale = recommendScale(input.spec, utilization, growth, bottlenecks, notes);

  return {
    generatedAt: new Date().toISOString(),
    hasLimits,
    growth,
    utilization,
    scale,
    bottlenecks,
    windowDays: input.windowDays,
    notes,
  };
}

// --- growth ----------------------------------------------------------------

async function computeGrowth(input: CapacityInput, notes: string[]): Promise<GrowthAnalysis[]> {
  const out: GrowthAnalysis[] = [];
  const diskUsed = await input.getSeries("DISK_PARTITION_SPACE_USED");
  const diskFree = await input.getSeries("DISK_PARTITION_SPACE_FREE");

  if (diskUsed.length >= MIN_POINTS) {
    const trend = linearTrend(diskUsed);
    if (trend && trend.spanDays >= MIN_SPAN_DAYS) {
      const perWeek = trend.perDay * 7;
      const perWeekPct = trend.latest > 0 ? (perWeek / trend.latest) * 100 : undefined;

      // Disk capacity: prefer used+free (actual partition size) over tier diskSizeGB.
      let capacityBytes: number | undefined;
      const freeLatest = latest(diskFree);
      if (freeLatest != null) capacityBytes = trend.latest + freeLatest;
      else if (input.spec?.diskSizeGB) capacityBytes = input.spec.diskSizeGB * 1024 ** 3;

      let daysUntilFull: number | undefined;
      let projectedFullDate: string | undefined;
      if (capacityBytes && trend.perDay > 0) {
        const remaining = capacityBytes - trend.latest;
        daysUntilFull = Math.max(0, remaining / trend.perDay);
        if (daysUntilFull < 3650) {
          projectedFullDate = new Date(Date.now() + daysUntilFull * 86_400_000)
            .toISOString()
            .slice(0, 10);
        }
      }

      out.push({
        metric: "DISK_PARTITION_SPACE_USED",
        units: "BYTES",
        trend,
        perWeek,
        perWeekPct,
        daysUntilFull,
        projectedFullDate,
      });
    } else {
      notes.push("Not enough disk history span for a reliable growth trend yet.");
    }
  } else {
    notes.push("No disk-usage history yet (needs at least a few data points).");
  }

  return out;
}

// --- utilization -----------------------------------------------------------

async function computeUtilization(
  input: CapacityInput,
  notes: string[],
): Promise<ResourceUtilization[]> {
  const out: ResourceUtilization[] = [];
  const spec = input.spec;

  // CPU: SYSTEM_NORMALIZED_CPU_* are already 0–100% per core → fraction of 100.
  const cpuUser = await input.getSeries("SYSTEM_NORMALIZED_CPU_USER");
  const cpuKernel = await input.getSeries("SYSTEM_NORMALIZED_CPU_KERNEL");
  const cpu = sumSeries(cpuUser, cpuKernel);
  if (cpu.length > 0) {
    out.push({
      resource: "cpu",
      label: "CPU",
      current: fracOf100(latest(cpu)),
      p95: fracOf100(percentile(cpu, 95)),
      latestValue: latest(cpu),
      limitValue: 100,
      units: "%",
    });
  }

  // Memory: CACHE_USED_BYTES vs RAM (WiredTiger cache is ~50% of RAM by default,
  // but cache-used/RAM is a reasonable working-set pressure proxy).
  const cacheUsed = await input.getSeries("CACHE_USED_BYTES");
  if (cacheUsed.length > 0 && spec?.ramGB) {
    const ramBytes = spec.ramGB * 1024 ** 3;
    out.push({
      resource: "memory",
      label: "Memory (cache vs RAM)",
      current: fracOf(latest(cacheUsed), ramBytes),
      p95: fracOf(percentile(cacheUsed, 95), ramBytes),
      latestValue: latest(cacheUsed),
      limitValue: ramBytes,
      units: "BYTES",
    });
  } else if (cacheUsed.length > 0) {
    out.push({
      resource: "memory",
      label: "Memory (cache used)",
      latestValue: latest(cacheUsed),
      unbounded: true,
      units: "BYTES",
    });
  }

  // Disk space: used / (used+free) or tier diskSizeGB.
  const diskUsed = await input.getSeries("DISK_PARTITION_SPACE_USED");
  const diskFree = await input.getSeries("DISK_PARTITION_SPACE_FREE");
  if (diskUsed.length > 0) {
    const usedLatest = latest(diskUsed);
    const freeLatest = latest(diskFree);
    let cap: number | undefined;
    if (usedLatest != null && freeLatest != null) cap = usedLatest + freeLatest;
    else if (spec?.diskSizeGB) cap = spec.diskSizeGB * 1024 ** 3;
    out.push({
      resource: "disk",
      label: "Disk space",
      current: fracOf(usedLatest, cap),
      p95: fracOf(percentile(diskUsed, 95), cap),
      latestValue: usedLatest,
      limitValue: cap,
      units: "BYTES",
      unbounded: cap == null,
    });
  }

  // Disk IOPS vs provisioned.
  const iops = await input.getSeries("DISK_PARTITION_IOPS_TOTAL");
  if (iops.length > 0) {
    const limit = spec?.diskIOPS;
    out.push({
      resource: "iops",
      label: "Disk IOPS",
      current: fracOf(latest(iops), limit),
      p95: fracOf(percentile(iops, 95), limit),
      latestValue: latest(iops),
      limitValue: limit,
      units: "IOPS",
      unbounded: limit == null,
    });
  }

  if (out.length === 0) notes.push("No utilization metrics available yet.");
  return out;
}

// --- bottleneck ranking (basic; 8c expands with slow-query signals) --------

function rankBottlenecks(
  util: ResourceUtilization[],
  growth: GrowthAnalysis[],
  querySignals: QuerySignal[],
): BottleneckSignal[] {
  const signals: BottleneckSignal[] = [];

  // Resource (hardware) signals.
  for (const u of util) {
    if (u.unbounded || u.p95 == null) continue;
    let score = Math.min(1, u.p95);
    const diskGrowth = growth.find((g) => g.metric.includes("DISK"));
    if (u.resource === "disk" && diskGrowth && diskGrowth.daysUntilFull != null) {
      if (diskGrowth.daysUntilFull < 30) score = Math.max(score, 0.9);
      else if (diskGrowth.daysUntilFull < 90) score = Math.max(score, 0.75);
    }
    signals.push({
      resource: u.label,
      kind: "resource",
      score,
      detail:
        `${u.label} p95 at ${(u.p95 * 100).toFixed(0)}% of limit` +
        (u.resource === "disk" && diskGrowth?.daysUntilFull != null
          ? `, projected full in ${Math.round(diskGrowth.daysUntilFull)}d`
          : ""),
      evidence: {
        p95Pct: Number((u.p95 * 100).toFixed(1)),
        currentPct: u.current != null ? Number((u.current * 100).toFixed(1)) : undefined,
        latestValue: u.latestValue,
        limitValue: u.limitValue,
      },
    });
  }

  // Query-layer signals (slow queries / COLLSCANs / poor targeting).
  for (const q of querySignals.slice(0, 5)) {
    const score = Math.min(1, querySeverity(q));
    if (score <= 0) continue;
    const scanNote =
      q.collscanCount > 0 ? `${q.collscanCount} collection scan(s)` : "";
    const targetNote =
      q.worstScannedPerReturned >= 10
        ? `scanned up to ${Math.round(q.worstScannedPerReturned)}× docs per returned`
        : "";
    signals.push({
      resource: `Query: ${q.namespace}`,
      kind: "query",
      score,
      detail:
        `${q.namespace}: ${q.slowCount} slow quer${q.slowCount === 1 ? "y" : "ies"}` +
        [scanNote, targetNote].filter(Boolean).map((x) => `, ${x}`).join("") +
        (q.maxDurationMs ? `, up to ${q.maxDurationMs}ms` : ""),
      evidence: {
        namespace: q.namespace,
        slowCount: q.slowCount,
        collscanCount: q.collscanCount,
        worstScannedPerReturned: Math.round(q.worstScannedPerReturned),
        maxDurationMs: q.maxDurationMs,
        example: q.example,
      },
    });
  }

  return signals.sort((a, b) => b.score - a.score).slice(0, 6);
}

// --- scale recommendation --------------------------------------------------

function recommendScale(
  spec: ClusterSpec | undefined,
  util: ResourceUtilization[],
  growth: GrowthAnalysis[],
  bottlenecks: BottleneckSignal[],
  notes: string[],
): ScaleRecommendation {
  const currentTier = spec?.instanceSize;
  const bounded = util.filter((u) => !u.unbounded && u.p95 != null);

  if (bounded.length === 0) {
    return {
      direction: "none",
      drivers: [],
      rationale: "Insufficient data or unknown limits to recommend scaling.",
      confidence: 0.2,
    };
  }

  // SCALE UP: any compute/memory resource p95 over target.
  const over = bounded.filter(
    (u) => (u.resource === "cpu" || u.resource === "memory") && (u.p95 ?? 0) > TARGET_UTIL,
  );
  // Disk imminent-full is a scale-up (disk) driver.
  const disk = growth.find((g) => g.metric.includes("DISK"));
  const diskUrgent = disk?.daysUntilFull != null && disk.daysUntilFull < 60;

  if (over.length > 0 || diskUrgent) {
    const worst = over.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0];
    const factor = worst ? (worst.p95 ?? 0) / TARGET_UTIL : 1.3;
    const drivers = [
      ...over.map((u) => u.label),
      ...(diskUrgent ? ["Disk space"] : []),
    ];
    return {
      direction: "up",
      factor: Number(factor.toFixed(2)),
      currentTier,
      targetTier: nextTierUp(currentTier),
      drivers,
      rationale:
        `Peak utilization exceeds the ${(TARGET_UTIL * 100).toFixed(0)}% target on: ` +
        `${drivers.join(", ")}.` +
        (diskUrgent && disk?.daysUntilFull != null
          ? ` Disk projected full in ~${Math.round(disk.daysUntilFull)} days.`
          : "") +
        ` Scaling up gives roughly ${((factor - 1) * 100).toFixed(0)}% more headroom to target.`,
      confidence: confidenceFrom(growth, bounded),
    };
  }

  // SCALE DOWN (cost): all bounded resources comfortably under the underutilized
  // threshold AND disk growth is slow.
  const allLow = bounded.every((u) => (u.p95 ?? 1) < UNDERUTILIZED_P95);
  const slowDiskGrowth = !disk || (disk.perWeekPct ?? 0) < 5;
  const downTier = nextTierDown(currentTier);
  if (allLow && slowDiskGrowth && downTier) {
    const peak = Math.max(...bounded.map((u) => u.p95 ?? 0));
    // Factor = how much spare before hitting target after a downsize (tiers ~2x).
    const factor = peak > 0 ? TARGET_UTIL / (peak * 2) : 2;
    return {
      direction: "down",
      factor: Number(factor.toFixed(2)),
      currentTier,
      targetTier: downTier,
      drivers: bounded.map((u) => u.label),
      rationale:
        `All measured resources are well under ${(UNDERUTILIZED_P95 * 100).toFixed(0)}% ` +
        `(peak p95 ${(peak * 100).toFixed(0)}%) with slow disk growth. ` +
        `You likely have room to scale down to ${downTier} for cost savings, ` +
        `keeping peak under the ${(TARGET_UTIL * 100).toFixed(0)}% target.`,
      confidence: confidenceFrom(growth, bounded),
    };
  }

  return {
    direction: "none",
    currentTier,
    drivers: bottlenecks.slice(0, 1).map((b) => b.resource),
    rationale:
      "Utilization is within a healthy band; no scaling action recommended right now.",
    confidence: confidenceFrom(growth, bounded),
  };
}

// --- helpers ---------------------------------------------------------------

function fracOf(value: number | undefined, limit: number | undefined): number | undefined {
  if (value == null || limit == null || limit <= 0) return undefined;
  return value / limit;
}
function fracOf100(value: number | undefined): number | undefined {
  return value == null ? undefined : value / 100;
}

/** Element-wise sum of two series by timestamp (for CPU user+kernel). */
function sumSeries(a: MetricPoint[], b: MetricPoint[]): MetricPoint[] {
  if (b.length === 0) return a;
  const map = new Map<number, number>();
  for (const p of a) map.set(p.ts.getTime(), p.value);
  for (const p of b) map.set(p.ts.getTime(), (map.get(p.ts.getTime()) ?? 0) + p.value);
  return [...map.entries()].sort((x, y) => x[0] - y[0]).map(([t, v]) => ({ ts: new Date(t), value: v }));
}

/** Confidence from trend R² and data coverage. */
function confidenceFrom(growth: GrowthAnalysis[], bounded: ResourceUtilization[]): number {
  const r2 = growth[0]?.trend.r2 ?? 0.5;
  const coverage = Math.min(1, bounded.length / 3);
  return Number((0.4 + 0.4 * r2 + 0.2 * coverage).toFixed(2));
}
