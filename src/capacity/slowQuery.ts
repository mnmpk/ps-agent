import type { QuerySignal } from "./types.js";

/**
 * Parses Atlas Performance Advisor slow-query log lines into per-namespace
 * signals: collection scans, query-targeting ratio (docsExamined/returned),
 * and durations. Pure + testable; filters out internal/system namespaces so we
 * report on user workload, not automation-agent noise.
 */

const INTERNAL_NS = /^(admin|local|config|__mdb_internal_search)\b/;
const INTERNAL_APP = /mongot|automation|mms-automation|MongoDB Automation Agent/i;

interface ParsedLine {
  ns?: string;
  planSummary?: string;
  docsExamined?: number;
  keysExamined?: number;
  nreturned?: number;
  durationMillis?: number;
  appName?: string;
  op?: string;
}

/** Parse a single slow-query log line (JSON string) into fields we care about. */
export function parseSlowQueryLine(line: string): ParsedLine | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const attr = obj?.attr ?? {};
  const cmd = attr.command ?? {};
  return {
    ns: attr.ns,
    planSummary: attr.planSummary,
    docsExamined: numOr(attr.docsExamined),
    keysExamined: numOr(attr.keysExamined),
    nreturned: numOr(attr.nreturned),
    durationMillis: numOr(attr.durationMillis),
    appName: attr.appName,
    op: attr.type ?? Object.keys(cmd)[0],
  };
}

/**
 * Aggregate raw slow-query log lines into per-namespace QuerySignal[], sorted by
 * severity (collscans + targeting + duration). Internal/automation traffic is
 * excluded so the signals reflect real user workload.
 */
export function aggregateSlowQueries(lines: string[]): QuerySignal[] {
  const byNs = new Map<string, QuerySignal>();

  for (const line of lines) {
    const p = parseSlowQueryLine(line);
    if (!p?.ns) continue;
    if (INTERNAL_NS.test(p.ns)) continue;
    if (p.appName && INTERNAL_APP.test(p.appName)) continue;

    const sig =
      byNs.get(p.ns) ??
      ({
        namespace: p.ns,
        slowCount: 0,
        collscanCount: 0,
        worstScannedPerReturned: 0,
        maxDurationMs: 0,
      } as QuerySignal);

    sig.slowCount++;
    if (p.planSummary && /COLLSCAN/.test(p.planSummary)) sig.collscanCount++;
    if (p.docsExamined != null && p.nreturned != null) {
      const ratio = p.docsExamined / Math.max(1, p.nreturned);
      if (ratio > sig.worstScannedPerReturned) {
        sig.worstScannedPerReturned = ratio;
        sig.example = `${p.op ?? "op"} examined ${p.docsExamined} docs, returned ${p.nreturned}` +
          (p.planSummary ? ` (${p.planSummary})` : "");
      }
    }
    if (p.durationMillis != null && p.durationMillis > sig.maxDurationMs) {
      sig.maxDurationMs = p.durationMillis;
    }
    byNs.set(p.ns, sig);
  }

  return [...byNs.values()].sort((a, b) => querySeverity(b) - querySeverity(a));
}

/** 0–1-ish severity score for ranking namespaces. */
export function querySeverity(s: QuerySignal): number {
  // Collection scans and high scanned-per-returned dominate.
  const scanScore = Math.min(1, s.worstScannedPerReturned / 1000);
  const collscanScore = s.slowCount > 0 ? s.collscanCount / s.slowCount : 0;
  const durScore = Math.min(1, s.maxDurationMs / 1000);
  return 0.5 * Math.max(scanScore, collscanScore) + 0.3 * scanScore + 0.2 * durScore;
}

function numOr(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
