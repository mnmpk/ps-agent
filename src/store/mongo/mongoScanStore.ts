import type { Collection } from "mongodb";
import type { ScanResult } from "../../core/types.js";
import type { ScanSnapshotMeta, ScanStore } from "../store.js";
import { getMongoDb } from "./client.js";

interface ScanDoc {
  _id: string; // `${sourceId}_${finishedAt.getTime()}`
  sourceId: string;
  sourceName: string;
  finishedAt: Date;
  scoreValue: number;
  result: ScanResult;
}

/**
 * MongoDB-backed scan snapshot store. Stores the full ScanResult plus flattened
 * fields for cheap listing/sorting. Indexes keep fleet/inbox queries fast.
 */
export class MongoScanStore implements ScanStore {
  private indexed = false;

  private async coll(): Promise<Collection<ScanDoc>> {
    const db = await getMongoDb();
    const c = db.collection<ScanDoc>("scans");
    if (!this.indexed) {
      // sourceId + recency for per-source latest lookups and fleet overview.
      await c.createIndex({ sourceId: 1, finishedAt: -1 });
      this.indexed = true;
    }
    return c;
  }

  async saveScan(result: ScanResult): Promise<string> {
    const id = `${result.sourceId}_${result.finishedAt.getTime()}`;
    const doc: ScanDoc = {
      _id: id,
      sourceId: result.sourceId,
      sourceName: result.sourceName,
      finishedAt: result.finishedAt,
      scoreValue: result.score.value,
      result,
    };
    await (await this.coll()).replaceOne({ _id: id }, doc, { upsert: true });
    return id;
  }

  async listScans(sourceId?: string): Promise<ScanSnapshotMeta[]> {
    const filter = sourceId ? { sourceId } : {};
    const docs = await (await this.coll())
      .find(filter, { projection: { result: 0 } })
      .sort({ finishedAt: -1 })
      .toArray();
    return docs.map((d) => ({
      id: d._id,
      sourceId: d.sourceId,
      sourceName: d.sourceName,
      finishedAt: new Date(d.finishedAt),
      score: d.scoreValue,
    }));
  }

  async getScan(id: string): Promise<ScanResult | null> {
    const doc = await (await this.coll()).findOne({ _id: id });
    if (!doc) return null;
    return reviveDates(doc.result);
  }
}

/** The driver returns Dates for BSON dates, but nested result may be stored raw. */
function reviveDates(result: ScanResult): ScanResult {
  const toDate = (v: unknown) => (typeof v === "string" ? new Date(v) : (v as Date));
  result.startedAt = toDate(result.startedAt);
  result.finishedAt = toDate(result.finishedAt);
  if (result.facts?.collectedAt) result.facts.collectedAt = toDate(result.facts.collectedAt);
  return result;
}
