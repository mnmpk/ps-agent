import type { Collection } from "mongodb";
import type { CachedReport, ReportKind, ReportStore } from "../store.js";
import { getMongoDb } from "./client.js";

interface ReportDoc {
  _id: string; // `${sourceId}|${kind}`
  sourceId: string;
  kind: ReportKind;
  computedAt: Date;
  basedOnScanAt: Date | null;
  payload: unknown;
}

/**
 * MongoDB-backed cache of the latest computed capacity/risk report per source
 * (collection `reports`). Keyed by a deterministic `_id` of `${sourceId}|${kind}`
 * so each save upserts in place, retaining only the most recent report per kind.
 */
export class MongoReportStore implements ReportStore {
  private indexed = false;

  private async coll(): Promise<Collection<ReportDoc>> {
    const db = await getMongoDb();
    const c = db.collection<ReportDoc>("reports");
    if (!this.indexed) {
      await c.createIndex({ sourceId: 1, kind: 1 });
      this.indexed = true;
    }
    return c;
  }

  private id(sourceId: string, kind: ReportKind): string {
    return `${sourceId}|${kind}`;
  }

  async saveReport<T>(report: CachedReport<T>): Promise<void> {
    const _id = this.id(report.sourceId, report.kind);
    const doc: ReportDoc = {
      _id,
      sourceId: report.sourceId,
      kind: report.kind,
      computedAt: report.computedAt,
      basedOnScanAt: report.basedOnScanAt,
      payload: report.payload,
    };
    await (await this.coll()).replaceOne({ _id }, doc, { upsert: true });
  }

  async getReport<T>(sourceId: string, kind: ReportKind): Promise<CachedReport<T> | null> {
    const doc = await (await this.coll()).findOne({ _id: this.id(sourceId, kind) });
    if (!doc) return null;
    return {
      sourceId: doc.sourceId,
      kind: doc.kind,
      computedAt: new Date(doc.computedAt),
      basedOnScanAt: doc.basedOnScanAt ? new Date(doc.basedOnScanAt) : null,
      payload: doc.payload as T,
    };
  }

  async removeForSource(sourceId: string): Promise<void> {
    await (await this.coll()).deleteMany({ sourceId });
  }
}
