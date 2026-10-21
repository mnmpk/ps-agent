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

  /**
   * Distinct (processId, metric, units) series available for a source — used to
   * drive per-node charts (which nodes have which metrics). `processId` is "" when
   * a series has no node id. `units` is the stored unit string (also carries the
   * member name for MEMBER_STATE_* series).
   */
  listSeries(sourceId: string): Promise<Array<{ processId: string; metric: string; units: string }>>;

  /** Remove all series for a source (on deregister). */
  removeSource(sourceId: string): Promise<void>;
}
