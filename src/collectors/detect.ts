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
 *   unknown      — anything we can't confidently classify
 */
export type DiagnosticKind = "getMongoData" | "mdiag" | "ftdc" | "unknown";

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
    // JSON but unrecognized shape.
    return { kind: "unknown", reason: "JSON but not a recognized getMongoData/mdiag export" };
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
  let gmd = 0;
  let mdiag = 0;
  let mdiagSignal = false;
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const section = typeof e.section === "string" ? e.section : "";
    const subsection = typeof e.subsection === "string" ? e.subsection : "";
    // mdiag entries commonly carry ref/version/command/rc; getMongoData carry host.
    if ("ref" in e || "version" in e || "command" in e || "rc" in e) mdiagSignal = true;
    if ("host" in e) gmd += 0.5;
    for (const s of [section, subsection]) {
      if (!s) continue;
      if (GMD_SECTIONS.has(s)) gmd++;
      if (MDIAG_SECTIONS.has(s)) mdiag++;
    }
  }
  if (gmd === 0 && mdiag === 0) {
    // No section hits — lean on the structural signal.
    return mdiagSignal ? "mdiag" : "unknown";
  }
  if (gmd > mdiag) return "getMongoData";
  if (mdiag > gmd) return "mdiag";
  // Tie → structural signal breaks it toward mdiag.
  return mdiagSignal ? "mdiag" : "getMongoData";
}
