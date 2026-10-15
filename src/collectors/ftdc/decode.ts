import { inflateSync } from "node:zlib";
import { BSON } from "mongodb";

/**
 * Low-level decoder for MongoDB FTDC (Full-Time Diagnostic Data Capture) archive
 * files (the `metrics.*` files under a mongod's `diagnostic.data/` directory).
 *
 * Format reference: https://github.com/mongodb/mongo/blob/master/src/mongo/db/ftdc/README.md
 *
 * A file is an append-only stream of BSON documents of three types:
 *   type 0 — metadata: { _id: Date, type: 0, doc: <collectors reference doc> }
 *   type 1 — metric chunk: { _id: Date, type: 1, data: BinData }
 *   type 2 — metadata delta (slowly-changing fields; we skip for metrics)
 *
 * Each type-1 chunk's `data` is: uint32 uncompressedSize + zlib-deflated payload.
 * The inflated payload is:
 *   referenceDocument (BSON) | uint32 metricCount | uint32 sampleCount | varint block
 * The varint block holds, column-major (metric-major), the delta of every sample
 * from the previous one, with runs of zeros RLE-encoded as the pair [0, count-1].
 *
 * We reconstruct, per numeric leaf path in the reference doc, a series of
 * (timestamp, value) samples. The sample timestamp is taken from the reference
 * doc's `start` field advanced by the per-sample delta of that same field when
 * present (FTDC samples every ~1s, and `start` is itself a tracked metric).
 */

/** One decoded FTDC chunk: metric paths (dot notation) → one value per sample. */
export interface FtdcChunk {
  /** Reference/metadata document for the chunk (first sample, full BSON). */
  reference: Record<string, unknown>;
  /** Ordered numeric leaf paths extracted from the reference document. */
  paths: string[];
  /** paths.length × sampleCount matrix of reconstructed values (metric-major). */
  values: number[][];
  /** Wall-clock timestamp (ms since epoch) for each sample. */
  timestamps: number[];
  sampleCount: number;
}

export interface FtdcDecodeResult {
  chunks: FtdcChunk[];
  /** Latest metadata (type-0) reference doc, if any — a serverStatus snapshot. */
  metadata: Record<string, unknown> | null;
  warnings: string[];
}

/** Returns true if the buffer looks like it starts with a BSON document. */
export function looksLikeFtdc(buf: Buffer): boolean {
  if (buf.length < 5) return false;
  const len = buf.readInt32LE(0);
  return len >= 5 && len <= buf.length;
}

/**
 * Precise FTDC header check, usable on a truncated prefix (the first doc may
 * exceed the peeked bytes). Every FTDC document begins with an `_id` field of
 * BSON type UTC-datetime (0x09) — i.e. bytes after the 4-byte length are:
 *   0x09 '_' 'i' 'd' 0x00
 * This reliably distinguishes FTDC from other binary files (e.g. WiredTiger
 * `.wt` files), which do not start with an `_id` datetime element.
 */
export function looksLikeBsonHeader(buf: Buffer): boolean {
  if (buf.length < 9) return false;
  const len = buf.readInt32LE(0);
  if (len < 5 || len > 64 * 1024 * 1024) return false;
  return (
    buf[4] === 0x09 && // BSON UTC datetime element
    buf[5] === 0x5f && // '_'
    buf[6] === 0x69 && // 'i'
    buf[7] === 0x64 && // 'd'
    buf[8] === 0x00 //    field-name terminator
  );
}

/**
 * Decode one or more concatenated FTDC archive files. Defensive: a corrupt
 * chunk is recorded as a warning and skipped; it never throws on bad data
 * (only on a buffer that is not a BSON stream at all).
 */
export function decodeFtdc(buf: Buffer): FtdcDecodeResult {
  const warnings: string[] = [];
  const chunks: FtdcChunk[] = [];
  let metadata: Record<string, unknown> | null = null;

  if (!looksLikeFtdc(buf)) {
    throw new Error("Not an FTDC file: does not start with a BSON document.");
  }

  let offset = 0;
  let docIndex = 0;
  while (offset + 4 <= buf.length) {
    const docLen = buf.readInt32LE(offset);
    if (docLen < 5 || offset + docLen > buf.length) {
      warnings.push(`FTDC: truncated/invalid BSON document at offset ${offset}; stopping.`);
      break;
    }
    const slice = buf.subarray(offset, offset + docLen);
    offset += docLen;
    docIndex++;

    let doc: any;
    try {
      doc = BSON.deserialize(slice, { promoteValues: true, promoteLongs: true });
    } catch (err) {
      warnings.push(`FTDC: failed to parse document #${docIndex}: ${(err as Error).message}`);
      continue;
    }

    const type = typeof doc.type === "number" ? doc.type : undefined;
    if (type === 0 || type === 2) {
      // Metadata: keep the richest one (type 0 full snapshot).
      if (type === 0 && doc.doc && typeof doc.doc === "object") {
        metadata = doc.doc as Record<string, unknown>;
      }
      continue;
    }
    if (type !== 1) continue; // unknown doc type

    const bin = doc.data;
    const dataBuf = toBuffer(bin);
    if (!dataBuf) {
      warnings.push(`FTDC: chunk #${docIndex} has no BinData payload; skipped.`);
      continue;
    }
    try {
      const chunk = decodeChunk(dataBuf);
      if (chunk) chunks.push(chunk);
    } catch (err) {
      warnings.push(`FTDC: failed to decode metric chunk #${docIndex}: ${(err as Error).message}`);
    }
  }

  return { chunks, metadata, warnings };
}

function toBuffer(bin: unknown): Buffer | null {
  if (!bin) return null;
  // bson Binary has .buffer; a raw Buffer/Uint8Array may also appear.
  const anyBin = bin as { buffer?: Uint8Array };
  if (anyBin.buffer instanceof Uint8Array) return Buffer.from(anyBin.buffer);
  if (bin instanceof Uint8Array) return Buffer.from(bin);
  return null;
}

/** Decode a single type-1 chunk's (already-extracted) `data` BinData payload. */
function decodeChunk(data: Buffer): FtdcChunk | null {
  if (data.length < 4) return null;
  // uint32 uncompressed size, then zlib-deflated payload.
  const zlibPayload = data.subarray(4);
  const inflated = inflateSync(zlibPayload);

  // Reference document is a BSON doc at the start of the inflated payload.
  const refLen = inflated.readInt32LE(0);
  if (refLen < 5 || refLen + 8 > inflated.length) return null;
  const reference = BSON.deserialize(inflated.subarray(0, refLen), {
    promoteValues: true,
    promoteLongs: true,
  }) as Record<string, unknown>;

  let p = refLen;
  const metricCount = inflated.readUInt32LE(p);
  p += 4;
  const deltaCount = inflated.readUInt32LE(p); // # of delta samples AFTER the reference
  p += 4;

  // Extract numeric leaf paths + their baseline values, in document order.
  // The reference document IS sample 0; the delta block produces samples
  // 1..deltaCount, so the total sample count is 1 + deltaCount.
  const { paths, baseline } = extractNumericLeaves(reference);
  if (paths.length !== metricCount) {
    // Schema mismatch (shouldn't happen for a well-formed chunk). Clamp.
    const nn = Math.min(paths.length, metricCount);
    paths.length = nn;
    baseline.length = nn;
  }
  const n = paths.length;
  const totalSamples = 1 + deltaCount;

  // Values matrix: metric-major, totalSamples columns. Column 0 = reference.
  const MASK = (1n << 64n) - 1n;
  const acc: bigint[] = new Array(n);
  const values: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    acc[i] = BigInt(Math.trunc(baseline[i] ?? 0)) & MASK;
    values[i] = new Array(totalSamples);
    values[i]![0] = Number(BigInt.asIntN(64, acc[i]!));
  }

  // Decode the delta block exactly as FTDC's decompressor does: metric-major,
  // for each metric j in 0..deltaCount-1 → sample j+1 = sample j + delta. A zero
  // delta is encoded as varint 0 followed by a varint "additional zeros" count;
  // that run carries the previous value forward. Deltas are plain unsigned
  // varints over wrapping uint64 (NO zig-zag); negatives wrap and are read back
  // via signed 64-bit interpretation.
  let zerosRemaining = 0n;
  for (let i = 0; i < n; i++) {
    let prev = acc[i]!;
    for (let j = 0; j < deltaCount; j++) {
      let delta: bigint;
      if (zerosRemaining > 0n) {
        delta = 0n;
        zerosRemaining--;
      } else {
        if (p >= inflated.length) {
          delta = 0n;
        } else {
          const [val, next] = readVarint(inflated, p);
          p = next;
          if (val === 0n) {
            // Next varint = count of ADDITIONAL zero deltas following this one.
            const [cnt, next2] = readVarint(inflated, p);
            p = next2;
            zerosRemaining = cnt;
            delta = 0n;
          } else {
            delta = val;
          }
        }
      }
      prev = (prev + delta) & MASK;
      values[i]![j + 1] = Number(BigInt.asIntN(64, prev));
    }
  }

  const timestamps = deriveTimestamps(paths, values, reference, totalSamples);
  return { reference, paths, values, timestamps, sampleCount: totalSamples };
}

/**
 * The per-sample wall-clock time. FTDC tracks `start` (a Date) as a metric, so
 * its reconstructed series IS the timestamp per sample. Fall back to the
 * reference `start`/`_id` + 1s spacing if not found.
 */
function deriveTimestamps(
  paths: string[],
  values: number[][],
  reference: Record<string, unknown>,
  sampleCount: number,
): number[] {
  // Prefer the top-level "start" metric (milliseconds since epoch).
  let tsIdx = paths.indexOf("start");
  if (tsIdx < 0) tsIdx = paths.findIndex((p) => p.endsWith(".start"));
  if (tsIdx >= 0) {
    const row = values[tsIdx]!;
    // Values are ms since epoch (datetime extracted as uint64 ms).
    if (row[0] && row[0] > 1e12) return row.slice(0, sampleCount);
  }
  // Fallback: reference start / _id + 1s per sample.
  const base =
    toMs(reference["start"]) ?? toMs((reference as any)._id) ?? Date.now();
  const out = new Array(sampleCount);
  for (let s = 0; s < sampleCount; s++) out[s] = base + s * 1000;
  return out;
}

function toMs(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return undefined;
}

/**
 * Walk a BSON doc depth-first, collecting every numeric leaf in document order
 * (the exact order FTDC's extractor uses). Numeric = double/int/long/bool/date/
 * timestamp. Dates → ms; booleans → 0/1; timestamps → two values (secs, inc).
 */
function extractNumericLeaves(doc: Record<string, unknown>): {
  paths: string[];
  baseline: number[];
} {
  const paths: string[] = [];
  const baseline: number[] = [];

  const visit = (val: unknown, path: string) => {
    if (val === null || val === undefined) return;
    if (typeof val === "number") {
      paths.push(path);
      baseline.push(val);
    } else if (typeof val === "boolean") {
      paths.push(path);
      baseline.push(val ? 1 : 0);
    } else if (typeof val === "bigint") {
      paths.push(path);
      baseline.push(Number(val));
    } else if (val instanceof Date) {
      paths.push(path);
      baseline.push(val.getTime());
    } else if (isBsonLong(val)) {
      paths.push(path);
      baseline.push(Number((val as any).toString()));
    } else if (isBsonTimestamp(val)) {
      // Timestamp extracted as two numbers: seconds (high), increment (low).
      const t = val as any;
      paths.push(path + ".t");
      baseline.push(Number(t.high ?? t.t ?? 0));
      paths.push(path + ".i");
      baseline.push(Number(t.low ?? t.i ?? 0));
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) visit(val[i], path ? `${path}.${i}` : String(i));
    } else if (typeof val === "object") {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k);
      }
    }
    // strings, ObjectId, Binary, etc. are not numeric → skipped.
  };

  for (const [k, v] of Object.entries(doc)) visit(v, k);
  return { paths, baseline };
}

function isBsonLong(v: unknown): boolean {
  const o = v as any;
  return o && typeof o === "object" && o._bsontype === "Long";
}
function isBsonTimestamp(v: unknown): boolean {
  const o = v as any;
  return o && typeof o === "object" && o._bsontype === "Timestamp";
}

/** Read an unsigned LEB128 varint at offset; returns [value, nextOffset]. */
function readVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    pos++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) break; // guard against runaway
  }
  return [result, pos];
}
