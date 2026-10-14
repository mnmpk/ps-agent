import type { MetricPoint } from "../core/types.js";

/**
 * Stores historical metric data points per source/metric for capacity & trend
 * analysis. Backfilled from the Atlas/OM API on first scan and appended on each
 * scan. File- and MongoDB-backed implementations exist (chosen by the factory).
 */
export interface MetricSeriesStore {
  /**
   * Upsert data points for (sourceId, processId, metric). Points are merged by
   * timestamp (idempotent) so repeated backfills/overlapping windows don't
   * duplicate. Returns the number of NEW points written.
   */
  appendPoints(
    sourceId: string,
    processId: string | undefined,
    metric: string,
    units: string,
    points: MetricPoint[],
  ): Promise<number>;

  /** Read a metric series within [since, now], oldest→newest. */
  getSeries(
    sourceId: string,
    metric: string,
    opts?: { processId?: string; since?: Date },
  ): Promise<MetricPoint[]>;

  /** Distinct metric names available for a source. */
  listMetrics(sourceId: string): Promise<string[]>;

  /** Remove all series for a source (on deregister). */
  removeSource(sourceId: string): Promise<void>;
}
