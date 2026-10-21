import type { MetricPoint } from "../../core/types.js";

/**
 * Time-bucket downsampling for FTDC series.
 *
 * FTDC is sampled ~once per second, which is ~3,600× finer than the resolution
 * the rest of the system uses (Atlas/OpsManager history and the capacity engine
 * target hourly — see src/capacity/historyBudget.ts, DEFAULT_HISTORY=PT1H). Full
 * per-second import would store tens of millions of points per node. We collapse
 * each series into fixed-width time buckets on import, bringing FTDC to parity
 * with the other metric sources with no loss of analytical value.
 *
 * Aggregation is per series type:
 *   - "mean" for gauges (cache/disk/connections) — the representative level.
 *   - "max"  for spiky rate series (CPU/IOPS) — preserves peaks so the capacity
 *            engine's p95 still reflects real spikes rather than smoothed averages.
 */
export type BucketAgg = "mean" | "max" | "last";

/**
 * Default bucket width (ms). 5 minutes by default — fine enough for readable
 * charts (≈288 points/series/day, ~130 MB/cluster/90d) while still ~300× sparser
 * than raw 1 Hz FTDC. Override with PS_AGENT_FTDC_BUCKET_SECONDS (e.g. 3600 for
 * hourly to minimize storage).
 */
export function defaultBucketMs(): number {
  const env = Number(process.env.PS_AGENT_FTDC_BUCKET_SECONDS);
  if (Number.isFinite(env) && env > 0) return env * 1000;
  return 300_000; // 5 minutes
}

/**
 * Collapse points into [floor(ts/bucket)] buckets, aggregating values. The
 * bucket timestamp is the bucket START (floored), so re-importing overlapping
 * files produces the SAME bucket timestamps → the store's merge-by-timestamp
 * stays idempotent across imports. Input need not be sorted.
 */
export function bucketPoints(
  points: MetricPoint[],
  bucketMs: number,
  agg: BucketAgg,
): MetricPoint[] {
  if (points.length === 0 || bucketMs <= 0) return points;

  // bucketStart → accumulator
  const acc = new Map<number, { sum: number; count: number; max: number; last: number; lastTs: number }>();
  for (const p of points) {
    const t = p.ts.getTime();
    const b = Math.floor(t / bucketMs) * bucketMs;
    const a = acc.get(b);
    if (!a) {
      acc.set(b, { sum: p.value, count: 1, max: p.value, last: p.value, lastTs: t });
    } else {
      a.sum += p.value;
      a.count++;
      if (p.value > a.max) a.max = p.value;
      if (t >= a.lastTs) {
        a.last = p.value;
        a.lastTs = t;
      }
    }
  }

  const out: MetricPoint[] = [];
  for (const [b, a] of acc) {
    let value: number;
    if (agg === "max") value = a.max;
    else if (agg === "last") value = a.last;
    else value = a.sum / a.count; // mean
    out.push({ ts: new Date(b), value });
  }
  out.sort((x, y) => x.ts.getTime() - y.ts.getTime());
  return out;
}

/**
 * Choose the aggregation for a canonical metric name. Spiky rate series use max
 * (to preserve peaks for p95); everything else is a level → mean.
 */
export function aggForMetric(metric: string): BucketAgg {
  // Replica-set member state is a categorical code (1=PRIMARY, 2=SECONDARY, …);
  // averaging is meaningless — keep the state at the end of each bucket.
  if (metric.startsWith("MEMBER_STATE_")) return "last";
  if (
    metric.startsWith("SYSTEM_NORMALIZED_CPU") ||
    metric === "SYSTEM_CPU_IOWAIT" ||
    metric === "DISK_PARTITION_IOPS_TOTAL" ||
    metric === "DISK_READ_OPS" ||
    metric === "DISK_WRITE_OPS" ||
    metric === "DISK_READ_LATENCY" ||
    metric === "DISK_WRITE_LATENCY" ||
    metric.startsWith("OPCOUNTER_")
  ) {
    return "max";
  }
  // % gauges (cache fill/dirty, memory util/frag) and byte/count gauges → mean.
  return "mean";
}
