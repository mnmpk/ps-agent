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

/**
 * Stateful, streaming accumulator for mongod.log lines. Feed it one line at a
 * time with `addLine()`, then call `finish()`. This lets both the in-memory
 * (`parseMongodLog`) and the streaming (`parseMongodLogFile`) entry points share
 * the exact per-line logic without ever holding the whole file — essential for
 * multi-hundred-MB production logs.
 */
export class MongodLogAccumulator {
  private readonly warnings: string[] = [];
  private readonly log: LogFacts = {
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
    warnings: this.warnings,
  };
  private readonly slowQueryLines: string[] = [];
  private readonly errorMsgCounts = new Map<string, { count: number; sample?: string }>();
  private parsedAny = false;
  private skipped = 0;
  private host: string | undefined;

  addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Structured logs are per-line JSON objects.
    if (trimmed[0] !== "{") {
      this.skipped++;
      return;
    }
    let e: LogEntry;
    try {
      e = JSON.parse(trimmed) as LogEntry;
    } catch {
      this.skipped++;
      return;
    }
    if (!e || typeof e !== "object" || (e.s === undefined && e.msg === undefined)) {
      this.skipped++;
      return;
    }
    const log = this.log;
    this.parsedAny = true;
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
      const cur = this.errorMsgCounts.get(key) ?? { count: 0, sample: sampleOf(attr) };
      cur.count++;
      this.errorMsgCounts.set(key, cur);
    }

    // --- Lifecycle: startups & shutdowns ---
    if (isStartup(msg, attr)) {
      log.startupCount++;
      const h = hostnameFrom(attr);
      if (h && !this.host) this.host = h;
      const v = versionFrom(attr);
      if (v && !log.mongoVersion) log.mongoVersion = v;
    }
    if (isUncleanShutdown(sev, msg)) log.uncleanShutdownCount++;

    // --- Replication ---
    // Elections span several log lines (dry run, vote requests, success). Count
    // only the "start" line so repeated elections aren't over-counted.
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
      this.slowQueryLines.push(trimmed);
    }
  }

  finish(): ParsedMongodLog {
    if (!this.parsedAny) {
      throw new Error(
        "Not a recognized mongod.log: no structured JSON log lines found (MongoDB 4.4+ JSON format required).",
      );
    }
    if (this.skipped > 0) {
      this.warnings.push(`${this.skipped} non-JSON / unparsable line(s) skipped.`);
    }
    if (this.errorMsgCounts.size > 0) {
      this.log.topErrors = [...this.errorMsgCounts.entries()]
        .map(([msg, v]) => ({ msg, count: v.count, sample: v.sample }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    }
    if (this.host) this.log.hostname = this.host;
    return { log: this.log, slowQueryLines: this.slowQueryLines, host: this.host };
  }
}

/** Parse a mongod.log held in memory as a string. */
export function parseMongodLog(raw: string): ParsedMongodLog {
  const acc = new MongodLogAccumulator();
  for (const line of raw.split(/\r?\n/)) acc.addLine(line);
  return acc.finish();
}

/**
 * Parse a mongod.log by STREAMING it from disk line-by-line (constant memory),
 * for large production logs that must not be read fully into a string.
 */
export async function parseMongodLogFile(path: string): Promise<ParsedMongodLog> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const acc = new MongodLogAccumulator();
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) acc.addLine(line);
  return acc.finish();
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
