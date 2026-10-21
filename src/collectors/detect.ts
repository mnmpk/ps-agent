import { looksLikeBsonHeader } from "./ftdc/decode.js";

/**
 * Content-based classifier for the diagnostic files operators collect. Lets a
 * single "import diagnostics" entry point accept any mix of files (a whole
 * folder) and route each to the right parser — the user never has to say what
 * kind each file is.
 *
 *   getMongoData — cluster-level JSON array (serverStatus/dbStats/replset/…)
 *   mdiag        — node-level OS/kernel JSON array (sysctl/THP/ulimit/SELinux/…)
 *   ftdc         — node-level binary BSON metric stream (diagnostic.data/metrics.*)
 *   mongodLog    — node-level structured JSON log (NDJSON of {t,s,c,id,msg,attr})
 *   unknown      — anything we can't confidently classify
 */
export type DiagnosticKind = "getMongoData" | "mdiag" | "ftdc" | "mongodLog" | "unknown";

export interface DetectResult {
  kind: DiagnosticKind;
  /** Short reason, for surfacing in import summaries / debugging. */
  reason: string;
}

/**
 * Classify a file by its raw bytes (+ optional filename hint). Binary FTDC is
 * detected by the BSON stream header; the two JSON kinds are told apart by the
 * section vocabulary in their entries. Never throws.
 */
export function detectDiagnostic(buf: Buffer, filename?: string): DetectResult {
  // 1) FTDC is binary. Every FTDC document starts with an `_id` UTC-datetime
  //    element — a precise signature that excludes WiredTiger/.wt and other
  //    binary files, and works on a truncated prefix.
  if (!looksLikeJsonStart(buf) && looksLikeBsonHeader(buf)) {
    return { kind: "ftdc", reason: "FTDC BSON stream (_id datetime header)" };
  }

  // 2) JSON array? Peek a small prefix; only parse fully if it looks like JSON.
  if (looksLikeJsonStart(buf)) {
    const text = buf.toString("utf8");
    const arr = tryParseArray(text);
    if (arr) {
      const kind = classifyJsonEntries(arr);
      if (kind !== "unknown") return { kind, reason: "JSON section vocabulary" };
    }
    // Not a JSON array — could be a structured mongod.log (NDJSON: one JSON
    // object per line, each with log-entry fields t/s/c/msg).
    if (looksLikeMongodLog(text)) {
      return { kind: "mongodLog", reason: "structured mongod.log JSON lines ({t,s,c,msg})" };
    }
    // JSON but unrecognized shape.
    return { kind: "unknown", reason: "JSON but not a recognized getMongoData/mdiag/mongod.log export" };
  }

  return { kind: "unknown", reason: "unrecognized format" };
}

/** True if the (trimmed) buffer start looks like the beginning of JSON. */
export function looksLikeJsonPrefix(buf: Buffer): boolean {
  return looksLikeJsonStart(buf);
}

/** True if the (trimmed) buffer start looks like the beginning of JSON. */
function looksLikeJsonStart(buf: Buffer): boolean {
  // Scan past leading whitespace in the first few bytes.
  const n = Math.min(buf.length, 64);
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue; // ws
    return c === 0x5b || c === 0x7b; // '[' or '{'
  }
  return false;
}

/**
 * True if the text looks like a structured mongod.log (MongoDB 4.4+): the first
 * few non-empty lines are JSON objects carrying log-entry fields. We require a
 * couple of the canonical keys (`t`/`s`/`c`/`msg`) to avoid matching other
 * NDJSON. Checks up to the first 20 lines so a stray blank/partial line at the
 * start doesn't defeat detection.
 */
function looksLikeMongodLog(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let checked = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== "{") return false; // structured logs are per-line objects
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") {
        const hasSev = typeof o.s === "string";
        const hasComp = typeof o.c === "string";
        const hasMsg = typeof o.msg === "string";
        const hasTs = o.t != null;
        // Require the message plus at least one of severity/component/timestamp.
        if (hasMsg && (hasSev || hasComp || hasTs)) return true;
      }
    } catch {
      /* truncated/last line — keep scanning a few more */
    }
    if (++checked >= 20) break;
  }
  return false;
}

/** Parse as a JSON array, salvaging a truncated trailing element if needed. */
function tryParseArray(text: string): any[] | null {
  const t = stripTrailingNoise(text);
  try {
    const p = JSON.parse(t);
    return Array.isArray(p) ? p : null;
  } catch {
    const end = t.lastIndexOf("]");
    if (end > 0) {
      try {
        const p = JSON.parse(t.slice(0, end + 1));
        return Array.isArray(p) ? p : null;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/** getMongoData appends a trailing "ERROR:" footer on failure; drop it. */
function stripTrailingNoise(raw: string): string {
  const idx = raw.lastIndexOf("\nERROR:");
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim();
}

// Section vocabularies that uniquely identify each JSON export.
const GMD_SECTIONS = new Set([
  "server_info",
  "server_status_info",
  "data_info",
  "replicaset_info",
  "replica_status",
  "shard_or_replicaset_info",
  "host_info",
  "command_line_info",
  "server_build_info",
  "server_parameters",
  "database_stats",
  "index_stats",
]);
const MDIAG_SECTIONS = new Set([
  "sysctl",
  "transparent_hugepage",
  "read_ahead_kb",
  "ulimit",
  "selinux",
  "numactl",
  "scheduler",
  "hostname",
  "uname",
  "meminfo",
  "cpuinfo",
  "dmesg",
  "mongod_config",
]);

function classifyJsonEntries(arr: any[]): DiagnosticKind {
  // Both exports are JSON arrays of `{section, host, ref, version, …}` entries,
  // and real-world files carry `host`/`ref`/`version`/`command` on BOTH — so those
  // are NOT discriminating. We classify primarily by SECTION VOCABULARY, which is
  // distinct and reliable (getMongoData: server_status_info/data_info/…; mdiag:
  // sysctl/transparent_hugepage/read_ahead_kb/…). As a structural tiebreaker, only
  // mdiag entries carry `script: "mdiag.sh"` or a non-trivial count of `rc` (shell
  // return codes); getMongoData has neither.
  let gmd = 0;
  let mdiag = 0;
  let mdiagStruct = false;
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const section = typeof e.section === "string" ? e.section : "";
    const subsection = typeof e.subsection === "string" ? e.subsection : "";
    if ((typeof e.script === "string" && /mdiag/i.test(e.script)) || "rc" in e) {
      mdiagStruct = true;
    }
    for (const s of [section, subsection]) {
      if (!s) continue;
      if (GMD_SECTIONS.has(s)) gmd++;
      if (MDIAG_SECTIONS.has(s)) mdiag++;
    }
  }
  // Decisive section-vocabulary winner.
  if (gmd > 0 && gmd > mdiag * 2) return "getMongoData";
  if (mdiag > 0 && mdiag > gmd * 2) return "mdiag";
  // Mixed/close counts — the mdiag structural marker (script/rc) breaks the tie;
  // getMongoData never has it.
  if (mdiagStruct) return "mdiag";
  if (gmd > mdiag) return "getMongoData";
  if (mdiag > gmd) return "mdiag";
  return "unknown";
}
