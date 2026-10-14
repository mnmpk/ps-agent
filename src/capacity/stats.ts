import type { MetricPoint } from "../core/types.js";
import type { Trend } from "./types.js";

/**
 * Ordinary least-squares linear regression of value vs time (in days), with R².
 * Time is measured in days relative to the first point so the slope is per-day.
 * Returns null if there are fewer than 2 points or zero time span.
 */
export function linearTrend(points: MetricPoint[]): Trend | null {
  const pts = points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (pts.length < 2) return null;

  const t0 = pts[0]!.ts.getTime();
  const xs = pts.map((p) => (p.ts.getTime() - t0) / 86_400_000); // days
  const ys = pts.map((p) => p.value);
  const spanDays = xs[xs.length - 1]!;
  if (spanDays <= 0) return null;

  const n = pts.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx; // per day
  const r2 = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));

  return {
    perDay: slope,
    r2,
    points: n,
    spanDays,
    latest: ys[ys.length - 1]!,
  };
}

/**
 * Exponentially-weighted moving average of the values (recency-weighted mean).
 * Useful as a robust "current level" that resists single-sample spikes.
 */
export function ewma(points: MetricPoint[], alpha = 0.3): number | undefined {
  const vals = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return undefined;
  let acc = vals[0]!;
  for (let i = 1; i < vals.length; i++) acc = alpha * vals[i]! + (1 - alpha) * acc;
  return acc;
}

/** Percentile (0–100) of a numeric series using linear interpolation. */
export function percentile(points: MetricPoint[], p: number): number | undefined {
  const vals = points.map((x) => x.value).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (vals.length === 0) return undefined;
  if (vals.length === 1) return vals[0];
  const rank = (p / 100) * (vals.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return vals[lo];
  return vals[lo]! + (rank - lo) * (vals[hi]! - vals[lo]!);
}

/** Most recent value. */
export function latest(points: MetricPoint[]): number | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    if (Number.isFinite(points[i]!.value)) return points[i]!.value;
  }
  return undefined;
}
