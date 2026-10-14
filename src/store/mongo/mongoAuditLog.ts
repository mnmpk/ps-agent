import type { Collection } from "mongodb";
import type { AuditEntry, AuditLog } from "../auditLog.js";
import { getMongoDb } from "./client.js";

interface AuditDoc extends AuditEntry {
  ts: Date; // indexed sort key (parsed from `at`)
}

/**
 * MongoDB-backed append-only audit log. Inserts only (never updates/deletes).
 * Secrets are never written here — callers pass already-redacted detail.
 */
export class MongoAuditLog implements AuditLog {
  private indexed = false;

  private async coll(): Promise<Collection<AuditDoc>> {
    const db = await getMongoDb();
    const c = db.collection<AuditDoc>("audit");
    if (!this.indexed) {
      await c.createIndex({ ts: -1 });
      this.indexed = true;
    }
    return c;
  }

  async record(entry: Omit<AuditEntry, "at">): Promise<void> {
    const at = new Date().toISOString();
    await (await this.coll()).insertOne({ ...entry, at, ts: new Date(at) });
  }

  async tail(limit = 100): Promise<AuditEntry[]> {
    const docs = await (await this.coll())
      .find({}, { projection: { _id: 0, ts: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    // Return most-recent last (ascending) to match the file log's semantics.
    return docs.reverse() as AuditEntry[];
  }
}
