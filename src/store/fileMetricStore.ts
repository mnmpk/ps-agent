import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MetricPoint } from "../core/types.js";
import type { MetricSeriesStore } from "./metricStore.js";

interface SeriesFile {
  sourceId: string;
  // key = `${processId||""}|${metric}` → { units, points: [[tsMillis, value], …] }
  series: Record<string, { units: string; points: Array<[number, number]> }>;
}

const TTL_DAYS = Number(process.env.PS_AGENT_METRIC_TTL_DAYS ?? 95);

/**
 * File-backed metric series store: one JSON file per source under
 * <dataDir>/metrics/<sourceId>.json. Points are merged by timestamp
 * (idempotent) and trimmed to the retention window on write. Writes are
 * serialized per source to avoid lost updates.
 */
export class FileMetricStore implements MetricSeriesStore {
  private readonly dir: string;
  private chains = new Map<string, Promise<unknown>>();

  constructor(dir?: string) {
    const base = process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent");
    this.dir = dir ?? join(base, "metrics");
  }

  private file(sourceId: string): string {
    return join(this.dir, `${sourceId}.json`);
  }

  private serialize<T>(sourceId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const run = prev.then(op, op);
    this.chains.set(sourceId, run.catch(() => undefined));
    return run;
  }

  private async read(sourceId: string): Promise<SeriesFile> {
    const f = this.file(sourceId);
    if (!existsSync(f)) return { sourceId, series: {} };
    try {
      return JSON.parse(await readFile(f, "utf8")) as SeriesFile;
    } catch {
      return { sourceId, series: {} };
    }
  }

  private async write(sourceId: string, data: SeriesFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(sourceId)}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, this.file(sourceId));
  }

  async appendPoints(
    sourceId: string,
    processId: string | undefined,
    metric: string,
    units: string,
    points: MetricPoint[],
  ): Promise<number> {
    if (points.length === 0) return 0;
    return this.serialize(sourceId, async () => {
      const data = await this.read(sourceId);
      const key = `${processId ?? ""}|${metric}`;
      const entry = data.series[key] ?? { units, points: [] };
      const byTs = new Map(entry.points.map((p) => [p[0], p[1]]));
      let added = 0;
      for (const p of points) {
        const t = p.ts.getTime();
        if (!byTs.has(t)) added++;
        byTs.set(t, p.value);
      }
      // Trim to retention window.
      const cutoff = Date.now() - TTL_DAYS * 24 * 3600 * 1000;
      const merged = [...byTs.entries()]
        .filter(([t]) => t >= cutoff)
        .sort((a, b) => a[0] - b[0]) as Array<[number, number]>;
      data.series[key] = { units, points: merged };
      await this.write(sourceId, data);
      return added;
    });
  }

  async getSeries(
    sourceId: string,
    metric: string,
    opts: { processId?: string; since?: Date } = {},
  ): Promise<MetricPoint[]> {
    const data = await this.read(sourceId);
    const sinceMs = opts.since?.getTime() ?? 0;

    // Specific process requested → that series only.
    if (opts.processId !== undefined) {
      const entry = data.series[`${opts.processId}|${metric}`];
      if (!entry) return [];
      return entry.points
        .filter(([t]) => t >= sinceMs)
        .map(([t, v]) => ({ ts: new Date(t), value: v }));
    }

    // No process specified → aggregate across all processes for this metric,
    // taking the max value per timestamp (correct for per-node disk/cache where
    // we care about the busiest node).
    const byTs = new Map<number, number>();
    for (const [key, entry] of Object.entries(data.series)) {
      const m = key.split("|").slice(1).join("|");
      if (m !== metric) continue;
      for (const [t, v] of entry.points) {
        if (t < sinceMs) continue;
        byTs.set(t, Math.max(byTs.get(t) ?? -Infinity, v));
      }
    }
    return [...byTs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ ts: new Date(t), value: v }));
  }

  async listMetrics(sourceId: string): Promise<string[]> {
    const data = await this.read(sourceId);
    const metrics = new Set<string>();
    for (const key of Object.keys(data.series)) {
      const metric = key.split("|").slice(1).join("|");
      if (metric) metrics.add(metric);
    }
    return [...metrics];
  }

  async removeSource(sourceId: string): Promise<void> {
    const f = this.file(sourceId);
    if (existsSync(f)) {
      try {
        await unlink(f);
      } catch {
        /* ignore */
      }
    }
  }
}
