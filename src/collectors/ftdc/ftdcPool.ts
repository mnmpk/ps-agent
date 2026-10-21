import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedFtdc } from "./parse.js";
import type { FtdcWorkerResponse } from "./worker.js";

/**
 * A small worker-thread pool that decodes FTDC files in parallel, mirroring
 * x-ray's multi-core FTDC reader. Each worker runs `parseFtdc` on one file and
 * returns the compact result (facts + curated series), so a multi-GB,
 * many-file FTDC import is bounded by CPU across all cores instead of one.
 *
 * Results are delivered to a callback AS EACH FILE COMPLETES (not buffered), so
 * the caller can append points and release memory incrementally. Falls back to
 * in-process decoding when workers can't be created.
 */

/** Resolve the worker entry file next to this module (.ts under tsx, .js in dist). */
function workerInfo(): { url: URL; isTs: boolean } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const file = join(dirname(here), isTs ? "worker.ts" : "worker.js");
  return { url: pathToFileURL(file), isTs };
}

/** Max parallelism — capped to keep memory reasonable on big boxes. */
function defaultWorkers(): number {
  const n = Number(process.env.PS_AGENT_FTDC_WORKERS) || 0;
  if (n > 0) return n;
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export interface FtdcDecodeOutcome {
  path: string;
  ok: boolean;
  result?: ParsedFtdc;
  error?: string;
}

/**
 * Decode many FTDC files in parallel. `onResult` is invoked once per file as it
 * finishes (order not guaranteed). Resolves when all files are done.
 */
export async function decodeFtdcFilesParallel(
  paths: string[],
  onResult: (outcome: FtdcDecodeOutcome) => Promise<void> | void,
): Promise<void> {
  if (paths.length === 0) return;

  const poolSize = Math.min(defaultWorkers(), paths.length);
  let workers: Worker[];
  try {
    workers = spawnWorkers(poolSize);
  } catch {
    // Worker threads unavailable → decode in-process (sequential fallback).
    await decodeInProcess(paths, onResult);
    return;
  }

  try {
    await runPool(workers, paths, onResult);
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
}

function spawnWorkers(n: number): Worker[] {
  const { url, isTs } = workerInfo();
  // Under tsx (dev), the worker is a .ts file — it needs the tsx loader too.
  const execArgv = isTs ? ["--import", "tsx"] : undefined;
  const workers: Worker[] = [];
  for (let i = 0; i < n; i++) {
    workers.push(new Worker(url, execArgv ? { execArgv } : undefined));
  }
  return workers;
}

/** Dispatch paths across idle workers, draining results as they complete. */
function runPool(
  workers: Worker[],
  paths: string[],
  onResult: (o: FtdcDecodeOutcome) => Promise<void> | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let completed = 0;
    const total = paths.length;
    let failed = false;

    const assign = (worker: Worker) => {
      if (next >= total) return; // nothing left for this worker
      const id = next++;
      worker.postMessage({ id, path: paths[id]! });
    };

    for (const worker of workers) {
      worker.on("message", async (res: FtdcWorkerResponse) => {
        try {
          await onResult({ path: res.path, ok: res.ok, result: res.result, error: res.error });
        } catch (err) {
          if (!failed) {
            failed = true;
            reject(err as Error);
          }
          return;
        }
        completed++;
        if (completed === total) {
          resolve();
          return;
        }
        assign(worker); // give this worker the next file
      });
      worker.on("error", (err) => {
        if (!failed) {
          failed = true;
          reject(err);
        }
      });
    }

    // Prime each worker with its first file.
    for (const worker of workers) assign(worker);
  });
}

/** Sequential, single-thread fallback (worker threads unavailable). */
async function decodeInProcess(
  paths: string[],
  onResult: (o: FtdcDecodeOutcome) => Promise<void> | void,
): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { parseFtdc } = await import("./parse.js");
  for (const path of paths) {
    try {
      const buf = await readFile(path);
      const result = parseFtdc(buf);
      await onResult({ path, ok: true, result });
    } catch (err) {
      await onResult({ path, ok: false, error: (err as Error).message });
    }
  }
}
