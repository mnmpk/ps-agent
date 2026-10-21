import type { AnyBulkWriteOperation, Collection } from "mongodb";
import type { MetricPoint } from "../../core/types.js";
import type { MetricSeriesStore } from "../metricStore.js";
import { getMongoDb } from "./client.js";

interface MetricDoc {
  _id: string; // `${sourceId}|${processId||""}|${metric}|${ts}` — idempotent
  sourceId: string;
  processId?: string;
  metric: string;
  units: string;
  ts: Date;
  value: number;
}

const TTL_DAYS = Number(process.env.PS_AGENT_METRIC_TTL_DAYS ?? 95);

/**
 * MongoDB-backed metric series store. One document per data point, keyed by a
 * deterministic _id so repeated backfills are idempotent. A TTL index on `ts`
 * bounds storage (default ~95 days, slightly above the 90-day history window).
 */
export class MongoMetricStore implements MetricSeriesStore {
  private indexed = false;

  private async coll(): Promise<Collection<MetricDoc>> {
    const db = await getMongoDb();
    const c = db.collection<MetricDoc>("metric_series");
    if (!this.indexed) {
      await c.createIndex({ sourceId: 1, metric: 1, processId: 1, ts: 1 });
      await c.createIndex({ ts: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 3600 });
      this.indexed = true;
    }
    return c;
  }

  async appendPoints(
    sourceId: string,
    processId: string | undefined,
    metric: string,
    units: string,
    points: MetricPoint[],
  ): Promise<number> {
    if (points.length === 0) return 0;
    const coll = await this.coll();
    const ops: AnyBulkWriteOperation<MetricDoc>[] = points.map((p) => {
      const id = `${sourceId}|${processId ?? ""}|${metric}|${p.ts.getTime()}`;
      return {
        updateOne: {
          filter: { _id: id },
          update: {
            $setOnInsert: {
              _id: id,
              sourceId,
              processId,
              metric,
              units,
              ts: p.ts,
              value: p.value,
            },
          },
          upsert: true,
        },
      };
    });
    const res = await coll.bulkWrite(ops, { ordered: false });
    return res.upsertedCount ?? 0;
  }

  async getSeries(
    sourceId: string,
    metric: string,
    opts: { processId?: string; since?: Date } = {},
  ): Promise<MetricPoint[]> {
    const coll = await this.coll();
    const match: Record<string, unknown> = { sourceId, metric };
    if (opts.processId !== undefined) match.processId = opts.processId;
    if (opts.since) match.ts = { $gte: opts.since };

    // When no process specified, aggregate across processes taking max per ts
    // (busiest node). Otherwise return that process's points directly.
    const docs = await coll
      .aggregate<{ _id: Date; value: number }>([
        { $match: match },
        { $group: { _id: "$ts", value: { $max: "$value" } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return docs.map((d) => ({ ts: new Date(d._id), value: d.value }));
  }

  async listMetrics(sourceId: string): Promise<string[]> {
    const coll = await this.coll();
    return (await coll.distinct("metric", { sourceId })) as string[];
  }

  async listSeries(sourceId: string): Promise<Array<{ processId: string; metric: string; units: string }>> {
    const coll = await this.coll();
    const docs = await coll
      .aggregate<{ _id: { processId?: string; metric: string }; units?: string }>([
        { $match: { sourceId } },
        { $group: { _id: { processId: "$processId", metric: "$metric" }, units: { $first: "$units" } } },
      ])
      .toArray();
    return docs.map((d) => ({ processId: d._id.processId ?? "", metric: d._id.metric, units: d.units ?? "" }));
  }

  async removeSource(sourceId: string): Promise<void> {
    const coll = await this.coll();
    await coll.deleteMany({ sourceId });
  }
}
