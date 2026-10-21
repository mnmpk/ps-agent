import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { parseFtdc, type ParsedFtdc } from "./parse.js";

/**
 * FTDC decode worker. Runs in a worker thread (see ftdcPool.ts): receives a file
 * path, reads + decodes it with the single-threaded `parseFtdc`, and posts back
 * the COMPACT result (facts + the ~11 curated capacity series) — never the raw
 * per-sample value matrices. This parallelizes the CPU-heavy inflate/BSON/varint
 * decode across cores (x-ray's ProcessPoolExecutor technique) while keeping the
 * data crossing the thread boundary small.
 */

export interface FtdcWorkerRequest {
  id: number;
  path: string;
}

export interface FtdcWorkerResponse {
  id: number;
  path: string;
  ok: boolean;
  /** Present when ok: the parsed, compact result. */
  result?: ParsedFtdc;
  /** Present when !ok. */
  error?: string;
}

if (parentPort) {
  parentPort.on("message", async (req: FtdcWorkerRequest) => {
    try {
      const buf = await readFile(req.path);
      const result = parseFtdc(buf);
      // buf goes out of scope here; only the compact result is transferred.
      parentPort!.postMessage({ id: req.id, path: req.path, ok: true, result } satisfies FtdcWorkerResponse);
    } catch (err) {
      parentPort!.postMessage({
        id: req.id,
        path: req.path,
        ok: false,
        error: (err as Error).message,
      } satisfies FtdcWorkerResponse);
    }
  });
}
