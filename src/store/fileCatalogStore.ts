import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RiskCatalogEntry } from "../risks/types.js";
import type { CatalogStore } from "./catalogStore.js";
import { loadSeedCatalog } from "../risks/catalog.js";

/**
 * File-backed mutable risk catalog (<dataDir>/risk-catalog.json). Seeds from the
 * committed risks-catalog.json the first time (file absent), then owns all edits.
 * Writes are serialized + atomic (temp file + rename).
 */
export class FileCatalogStore implements CatalogStore {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file?: string) {
    const dir = process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent");
    this.file = file ?? join(dir, "risk-catalog.json");
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<RiskCatalogEntry[]> {
    if (!existsSync(this.file)) {
      // Seed from the committed catalog (enabled by default).
      const seed = loadSeedCatalog().map((r) => ({ ...r, enabled: r.enabled ?? true }));
      await this.write(seed);
      return seed;
    }
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { risks: RiskCatalogEntry[] };
      return (data.risks ?? []).map((r) => ({ ...r, enabled: r.enabled ?? true }));
    } catch {
      return [];
    }
  }

  private async write(risks: RiskCatalogEntry[]): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ risks }, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  async list(): Promise<RiskCatalogEntry[]> {
    return this.read();
  }

  async upsert(entry: RiskCatalogEntry): Promise<RiskCatalogEntry> {
    return this.serialize(async () => {
      const all = await this.read();
      const e = { ...entry, enabled: entry.enabled ?? true };
      const idx = all.findIndex((r) => r.id === e.id);
      if (idx >= 0) all[idx] = e;
      else all.push(e);
      await this.write(all);
      return e;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const all = await this.read();
      const next = all.filter((r) => r.id !== id);
      if (next.length === all.length) return false;
      await this.write(next);
      return true;
    });
  }

  async replaceAll(entries: RiskCatalogEntry[]): Promise<void> {
    return this.serialize(async () => {
      await this.write(entries.map((r) => ({ ...r, enabled: r.enabled ?? true })));
    });
  }
}
