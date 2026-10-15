import type { RiskCatalogEntry } from "../risks/types.js";

/**
 * Persists the (mutable) risk catalog. Seeded from the committed
 * risks-catalog.json on first use; thereafter all CRUD edits live in the store.
 * File- and MongoDB-backed implementations exist (chosen by the factory).
 */
export interface CatalogStore {
  /** All catalog entries (enabled and disabled). Seeds from JSON if empty. */
  list(): Promise<RiskCatalogEntry[]>;
  /** Insert or update one entry (by id). */
  upsert(entry: RiskCatalogEntry): Promise<RiskCatalogEntry>;
  /** Delete by id. Returns true if removed. */
  remove(id: string): Promise<boolean>;
  /** Replace the entire catalog (used by import --replace). */
  replaceAll(entries: RiskCatalogEntry[]): Promise<void>;
}
