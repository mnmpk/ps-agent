import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CachedReport, ReportKind, ReportStore } from "./store.js";

/**
 * File-backed cache of the latest computed capacity/risk report per source.
 * One JSON file per (source, kind) under <dataDir>/reports/<sourceId>_<kind>.json.
 * Writes are atomic (temp file + rename) and serialized per key to avoid lost
 * updates, mirroring the other file stores.
 */
export class FileReportStore implements ReportStore {
  private readonly dir: string;
  private chains = new Map<string, Promise<unknown>>();

  constructor(dir?: string) {
    const base = process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent");
    this.dir = dir ?? join(base, "reports");
  }

  private file(sourceId: string, kind: ReportKind): string {
    // Encode to keep the filename safe for odd sourceIds.
    const safe = encodeURIComponent(sourceId);
    return join(this.dir, `${safe}_${kind}.json`);
  }

  private serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(op, op);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  async saveReport<T>(report: CachedReport<T>): Promise<void> {
    const key = `${report.sourceId}_${report.kind}`;
    await this.serialize(key, async () => {
      await mkdir(this.dir, { recursive: true });
      const path = this.file(report.sourceId, report.kind);
      const json = JSON.stringify(report, (_k, v) =>
        v instanceof Date ? v.toISOString() : v,
      );
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, json, "utf8");
      await rename(tmp, path);
    });
  }

  async getReport<T>(sourceId: string, kind: ReportKind): Promise<CachedReport<T> | null> {
    const path = this.file(sourceId, kind);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as CachedReport<T>;
      return reviveDates(raw);
    } catch {
      return null;
    }
  }

  async removeForSource(sourceId: string): Promise<void> {
    for (const kind of ["capacity", "risks"] as ReportKind[]) {
      const path = this.file(sourceId, kind);
      if (existsSync(path)) {
        await unlink(path).catch(() => undefined);
      }
    }
  }
}

/** Revive the top-level Date fields stored as ISO strings. */
function reviveDates<T>(r: CachedReport<T>): CachedReport<T> {
  const toDate = (v: unknown) => (typeof v === "string" ? new Date(v) : (v as Date));
  r.computedAt = toDate(r.computedAt);
  r.basedOnScanAt = r.basedOnScanAt ? toDate(r.basedOnScanAt) : null;
  return r;
}
