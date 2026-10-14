import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScanResult } from "../core/types.js";
import type { ScanSnapshotMeta, ScanStore } from "./store.js";

/** Reviver that turns ISO date strings back into Date for known fields. */
function reviveDates(result: any): ScanResult {
  const toDate = (v: unknown) => (typeof v === "string" ? new Date(v) : v);
  result.startedAt = toDate(result.startedAt);
  result.finishedAt = toDate(result.finishedAt);
  if (result.facts?.collectedAt) result.facts.collectedAt = toDate(result.facts.collectedAt);
  return result as ScanResult;
}

/**
 * Simple JSON-file snapshot store under ~/.ps-agent/scans by default.
 * Good enough for CLI + local dev; swap for a MongoDB store in production.
 */
export class FileScanStore implements ScanStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent", "scans");
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async saveScan(result: ScanResult): Promise<string> {
    await this.ensureDir();
    const id = `${result.sourceId}_${result.finishedAt.getTime()}`;
    const path = join(this.dir, `${id}.json`);
    const json = JSON.stringify(
      result,
      (_k, v) => (v instanceof Date ? v.toISOString() : v),
      2,
    );
    await writeFile(path, json, "utf8");
    return id;
  }

  async listScans(sourceId?: string): Promise<ScanSnapshotMeta[]> {
    await this.ensureDir();
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const metas: ScanSnapshotMeta[] = [];
    for (const f of files) {
      const result = reviveDates(JSON.parse(await readFile(join(this.dir, f), "utf8")));
      if (sourceId && result.sourceId !== sourceId) continue;
      metas.push({
        id: f.replace(/\.json$/, ""),
        sourceId: result.sourceId,
        sourceName: result.sourceName,
        finishedAt: result.finishedAt,
        score: result.score.value,
      });
    }
    return metas.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  }

  async getScan(id: string): Promise<ScanResult | null> {
    try {
      const raw = await readFile(join(this.dir, `${id}.json`), "utf8");
      return reviveDates(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
