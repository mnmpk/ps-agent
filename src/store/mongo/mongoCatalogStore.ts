import type { Collection } from "mongodb";
import type { RiskCatalogEntry } from "../../risks/types.js";
import type { CatalogStore } from "../catalogStore.js";
import { loadSeedCatalog } from "../../risks/catalog.js";
import { getMongoDb } from "./client.js";

interface CatalogDoc extends RiskCatalogEntry {
  _id: string; // mirrors entry.id
}

/**
 * MongoDB-backed mutable risk catalog (collection `risk_catalog`). Seeds from the
 * committed risks-catalog.json on first use (empty collection), then owns edits.
 */
export class MongoCatalogStore implements CatalogStore {
  private async coll(): Promise<Collection<CatalogDoc>> {
    const db = await getMongoDb();
    return db.collection<CatalogDoc>("risk_catalog");
  }

  private async seedIfEmpty(coll: Collection<CatalogDoc>): Promise<void> {
    if ((await coll.estimatedDocumentCount()) > 0) return;
    const seed = loadSeedCatalog();
    if (seed.length === 0) return;
    await coll.insertMany(
      seed.map((r) => ({ ...r, enabled: r.enabled ?? true, _id: r.id })),
      { ordered: false },
    ).catch(() => undefined);
  }

  async list(): Promise<RiskCatalogEntry[]> {
    const coll = await this.coll();
    await this.seedIfEmpty(coll);
    const docs = await coll.find({}, { projection: { _id: 0 } }).toArray();
    return docs.map((d) => ({ ...d, enabled: d.enabled ?? true }));
  }

  async upsert(entry: RiskCatalogEntry): Promise<RiskCatalogEntry> {
    const coll = await this.coll();
    const e = { ...entry, enabled: entry.enabled ?? true };
    await coll.replaceOne({ _id: e.id }, { ...e, _id: e.id } as unknown as CatalogDoc, { upsert: true });
    return e;
  }

  async remove(id: string): Promise<boolean> {
    const coll = await this.coll();
    const res = await coll.deleteOne({ _id: id });
    return res.deletedCount === 1;
  }

  async replaceAll(entries: RiskCatalogEntry[]): Promise<void> {
    const coll = await this.coll();
    await coll.deleteMany({});
    if (entries.length) {
      await coll.insertMany(
        entries.map((r) => ({ ...r, enabled: r.enabled ?? true, _id: r.id })),
        { ordered: false },
      );
    }
  }
}
