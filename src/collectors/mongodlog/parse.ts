import type { LogFacts } from "../../core/types.js";

/**
 * Parses a MongoDB `mongod.log` file in the structured JSON format (MongoDB
 * 4.4+). The file is newline-delimited JSON: one object per line, each shaped
 *
 *   { "t": {"$date": "..."}, "s": "I|W|E|F|D1..", "c": "<COMPONENT>",
 *     "id": <number>, "ctx": "<thread>", "msg": "<message>", "attr": {...} }
 *
 * We distill the stream into two complementary outputs:
 *  - `log` (LogFacts): rolled-up operational signals (errors, elections,
 *    restarts, storage warnings, assertions, connection churn, …) consumed by
 *    the `log.*` health checks.
 *  - `slowQueryLines`: the raw JSON lines whose msg is "Slow query", handed to
 *    the existing capacity slow-query aggregator (src/capacity/slowQuery.ts).
 *
 * Pure + defensive: malformed lines are skipped (counted in warnings), never
 * throws on bad content. Throws only when NOT a single structured line parses,
 * so callers can report "not a recognized mongod.log".
 */

export interface ParsedMongodLog {
  log: LogFacts;
  /** Raw JSON lines for msg "Slow query" (for aggregateSlowQueries). */
  slowQueryLines: string[];
  /** Hostname from a startup line, if any (for node reconciliation). */
  host?: string;
}

/** The subset of a structured log entry we read. */
interface LogEntry {
  s?: string; // severity: I W E F D1..D5
  c?: string; // component: REPL, STORAGE, NETWORK, CONTROL, …
  id?: number;
  ctx?: string;
  msg?: string;
  attr?: Record<string, unknown>;
  t?: unknown; // { $date: "..." } or string
}

export function parseMongodLog(raw: string): ParsedMongodLog {
  const warnings: string[] = [];
  const log: LogFacts = {
    errorCount: 0,
    fatalCount: 0,
    warningCount: 0,
    totalLines: 0,
    startupCount: 0,
    uncleanShutdownCount: 0,
    electionCount: 0,
    stateChangeCount: 0,
    storageWarningCount: 0,
    assertionCount: 0,
    connectionsAccepted: 0,
    connectionsEnded: 0,
    slowQueryCount: 0,
    warnings,
  };
  const slowQueryLines: string[] = [];
  const errorMsgCounts = new Map<string, { count: number; sample?: string }>();

  let parsedAny = false;
  let skipped = 0;
  let host: string | undefined;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Structured logs are per-line JSON objects.
    if (trimmed[0] !== "{") {
      skipped++;
      continue;
    }
    let e: LogEntry;
    try {
      e = JSON.parse(trimmed) as LogEntry;
    } catch {
      skipped++;
      continue;
    }
    if (!e || typeof e !== "object" || (e.s === undefined && e.msg === undefined)) {
      skipped++;
      continue;
    }
    parsedAny = true;
    log.totalLines++;

    const sev = e.s ?? "";
    const comp = (e.c ?? "").toUpperCase();
    const msg = e.msg ?? "";
    const attr = e.attr ?? {};

    // --- Timestamps (covered window) ---
    const ts = isoTs(e.t);
    if (ts) {
      if (!log.firstTs || ts < log.firstTs) log.firstTs = ts;
      if (!log.lastTs || ts > log.lastTs) log.lastTs = ts;
    }

    // --- Severity tallies ---
    if (sev === "E") log.errorCount++;
    else if (sev === "F") log.fatalCount++;
    else if (sev === "W") log.warningCount++;

    // Track the most frequent error/fatal messages for actionable findings.
    if (sev === "E" || sev === "F") {
      const key = msg || "(no message)";
      const cur = errorMsgCounts.get(key) ?? { count: 0, sample: sampleOf(attr) };
      cur.count++;
      errorMsgCounts.set(key, cur);
    }

    // --- Lifecycle: startups & shutdowns ---
    if (isStartup(msg, attr)) {
      log.startupCount++;
      const h = hostnameFrom(attr);
      if (h && !host) host = h;
      const v = versionFrom(attr);
      if (v && !log.mongoVersion) log.mongoVersion = v;
    }
    if (isUncleanShutdown(sev, msg)) log.uncleanShutdownCount++;

    // --- Replication ---
    // Elections span several log lines (dry run, vote requests, success). Count
    // only the "start" line so repeated elections aren't over-counted. The start
    // is logged under the ELECTION/REPL components as "Starting an election…".
    if ((comp === "ELECTION" || comp === "REPL" || comp.startsWith("REPL_")) &&
        /(starting|conducting|calling) an election/i.test(msg)) {
      log.electionCount++;
    }
    if (comp === "REPL" || comp.startsWith("REPL_")) {
      if (isStateChange(msg)) log.stateChangeCount++;
    }

    // --- Storage / WiredTiger warnings & errors ---
    if ((comp === "STORAGE" || comp === "WT" || comp === "WTCHKPT") && (sev === "W" || sev === "E" || sev === "F")) {
      log.storageWarningCount++;
    }

    // --- Assertions / invariant failures ---
    if (isAssertion(msg)) log.assertionCount++;

    // --- Connection churn ---
    if (comp === "NETWORK") {
      if (/connection accepted/i.test(msg)) log.connectionsAccepted++;
      if (/connection ended/i.test(msg)) log.connectionsEnded++;
    }

    // --- Slow queries → hand off to the capacity aggregator ---
    if (msg === "Slow query") {
      log.slowQueryCount++;
      slowQueryLines.push(trimmed);
    }
  }

  if (!parsedAny) {
    throw new Error(
      "Not a recognized mongod.log: no structured JSON log lines found (MongoDB 4.4+ JSON format required).",
    );
  }

  if (skipped > 0) {
    warnings.push(`${skipped} non-JSON / unparsable line(s) skipped.`);
  }

  // Top error messages (most frequent first), capped to keep facts compact.
  if (errorMsgCounts.size > 0) {
    log.topErrors = [...errorMsgCounts.entries()]
      .map(([msg, v]) => ({ msg, count: v.count, sample: v.sample }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  if (host) log.hostname = host;

  return { log, slowQueryLines, host };
}

/** Extract an ISO timestamp string from the log entry's `t` field. */
function isoTs(t: unknown): string | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    const d = (t as Record<string, unknown>)["$date"];
    if (typeof d === "string") return d;
  }
  return undefined;
}

function isStartup(msg: string, attr: Record<string, unknown>): boolean {
  // Canonical startup banner (id 4615611) + common variants.
  if (/MongoDB starting/i.test(msg)) return true;
  if (/Build Info/i.test(msg) && attr && "buildInfo" in attr) return true;
  return false;
}

function isUncleanShutdown(sev: string, msg: string): boolean {
  if (/Received signal/i.test(msg)) return true;
  if (/shutting down with code/i.test(msg)) return true;
  if (/terminating/i.test(msg) && (sev === "E" || sev === "F")) return true;
  if (/Fatal assertion/i.test(msg)) return true;
  return false;
}

function isStateChange(msg: string): boolean {
  return (
    /transition to (PRIMARY|SECONDARY|ROLLBACK|RECOVERING|STARTUP2)/i.test(msg) ||
    /replSetStepDown/i.test(msg) ||
    /Member is now in state/i.test(msg)
  );
}

function isAssertion(msg: string): boolean {
  return /assertion|invariant failure|fassert/i.test(msg);
}

function hostnameFrom(attr: Record<string, unknown>): string | undefined {
  // Startup lines may carry host in attr.host or attr.hostInfo.
  const h = attr["host"];
  if (typeof h === "string" && h) return h.split(":")[0];
  return undefined;
}

function versionFrom(attr: Record<string, unknown>): string | undefined {
  const bi = attr["buildInfo"];
  if (bi && typeof bi === "object") {
    const v = (bi as Record<string, unknown>)["version"];
    if (typeof v === "string") return v;
  }
  const v = attr["version"];
  return typeof v === "string" ? v : undefined;
}

/** A short, human-readable sample of an error line's attributes. */
function sampleOf(attr: Record<string, unknown>): string | undefined {
  if (!attr || Object.keys(attr).length === 0) return undefined;
  try {
    const s = JSON.stringify(attr);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return undefined;
  }
}
