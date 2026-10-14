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
