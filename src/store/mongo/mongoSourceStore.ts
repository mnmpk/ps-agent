import type { Collection } from "mongodb";
import { SourceSchema, type Source } from "../../core/source.js";
import type { SourceStore } from "../sourceStore.js";
import { decryptSource, decryptSources, encryptSource } from "../sourceStore.js";
import { getMongoDb } from "./client.js";

interface SourceDoc extends Source {
  _id: string; // mirrors Source.id
}

/**
 * MongoDB-backed source registry. Same interface as FileSourceStore; secrets
 * are encrypted (AES-256-GCM) before being stored, exactly as on the file
 * store, so the database never holds plaintext credentials.
 */
export class MongoSourceStore implements SourceStore {
  private async coll(): Promise<Collection<SourceDoc>> {
    const db = await getMongoDb();
    return db.collection<SourceDoc>("sources");
  }

  async list(): Promise<Source[]> {
    const docs = await (await this.coll()).find({}).toArray();
    // Per-record safe decrypt; skips (warns) any record we can't decrypt.
    return decryptSources(docs.map((d) => stripId(d)));
  }

  async get(id: string): Promise<Source | null> {
    const doc = await (await this.coll()).findOne({ _id: id });
    if (!doc) return null;
    try {
      const parsed = SourceSchema.safeParse(decryptSource(stripId(doc)));
      return parsed.success ? parsed.data : null;
    } catch {
      // Undecryptable (key changed / corrupt) — treat as not found.
      return null;
    }
  }

  async upsert(source: Source): Promise<Source> {
    const parsed = SourceSchema.parse(source);
    const encrypted = encryptSource(parsed);
    // Deep-strip undefined/null so we never persist nested nulls (e.g. mcp.url),
    // which would later fail Zod's .optional() validation on read.
    const doc = stripNullish(encrypted) as Record<string, unknown>;
    doc._id = parsed.id;
    await (await this.coll()).replaceOne({ _id: parsed.id }, doc as unknown as SourceDoc, {
      upsert: true,
    });
    return parsed;
  }

  async remove(id: string): Promise<boolean> {
    const res = await (await this.coll()).deleteOne({ _id: id });
    return res.deletedCount === 1;
  }
}

function stripId(doc: SourceDoc): Source {
  const { _id, ...rest } = doc;
  // The source's `id` is stored as `_id`; map it back for the schema.
  const withId = stripNullish({ ...rest, id: rest.id ?? _id }) as Record<string, unknown>;
  if (withId.id == null) withId.id = _id;
  return withId as Source;
}

/**
 * Recursively remove null/undefined values. MongoDB stores absent optional
 * fields as `null` (including nested ones like `mcp.url`), but Zod's
 * `.optional()` only accepts `undefined`, so these must be dropped on both read
 * and write. Without this, a record with `mcp.url: null` fails validation and
 * `get()` returns null → "Source not found".
 */
function stripNullish<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNullish(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNullish(v);
    }
    return out as T;
  }
  return value;
}
