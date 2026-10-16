import type { ScanResult } from "../core/types.js";

/**
 * Persists scan snapshots. The dashboard/scheduler phases will read from this.
 * Default implementation is file-based; a MongoDB-backed store can implement
 * the same interface later without touching callers.
 */
export interface ScanStore {
  saveScan(result: ScanResult): Promise<string>; // returns snapshot id
  listScans(sourceId?: string): Promise<ScanSnapshotMeta[]>;
  getScan(id: string): Promise<ScanResult | null>;
}

export interface ScanSnapshotMeta {
  id: string;
  sourceId: string;
  sourceName: string;
  finishedAt: Date;
  score: number;
}

/**
 * Kinds of derived reports we cache so users don't have to recompute them on
 * every view. Each is expensive to produce (live Atlas/OpsManager API calls,
 * metric aggregation, and/or an LLM round-trip).
 */
export type ReportKind = "capacity" | "risks";

/**
 * A cached report, keyed by (sourceId, kind). `payload` is the report object
 * exactly as computed (e.g. CapacityReport or RiskReport). `computedAt` is when
 * it was produced; `basedOnScanAt` records the finishedAt of the latest scan it
 * was computed from, so the cache can be invalidated when a newer scan arrives.
 */
export interface CachedReport<T = unknown> {
  sourceId: string;
  kind: ReportKind;
  computedAt: Date;
  /** finishedAt of the newest scan at compute time, or null if none existed. */
  basedOnScanAt: Date | null;
  payload: T;
}

/**
 * Persists the most recent computed capacity/risk report per source so the
 * dashboard and chat can serve the last result instantly instead of recomputing
 * on every request. Only the latest report of each kind is retained.
 */
export interface ReportStore {
  saveReport<T>(report: CachedReport<T>): Promise<void>;
  getReport<T>(sourceId: string, kind: ReportKind): Promise<CachedReport<T> | null>;
  removeForSource(sourceId: string): Promise<void>;
}
