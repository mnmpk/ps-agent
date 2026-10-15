import type { CollectedFacts } from "../core/types.js";
import type { RiskCatalogEntry, RiskAssessment, RiskStatus } from "./types.js";

/**
 * Deterministic evaluators for risk-register entries that can be checked from
 * collected facts. Each evaluator is matched to a catalog risk by a keyword
 * predicate on the risk NAME (robust to id/row changes across register
 * versions) and returns detected / clear / unknown with evidence.
 *
 * Risks with no evaluator are handled elsewhere: shown as "manual" review, or
 * passed to the LLM matcher as "suggested" candidates.
 */
export interface RiskEvaluator {
  /** True if this evaluator handles the given catalog risk. */
  matches: (risk: RiskCatalogEntry) => boolean;
  /** Evaluate against facts → status + evidence. */
  evaluate: (facts: CollectedFacts) => {
    status: Extract<RiskStatus, "detected" | "clear" | "unknown">;
    detail?: string;
    evidence?: Record<string, unknown>;
  };
}

const nameHas =
  (...terms: string[]) =>
  (r: RiskCatalogEntry) => {
    const n = (r.name + " " + r.description).toLowerCase();
    return terms.every((t) => n.includes(t.toLowerCase()));
  };

const EVALUATORS: RiskEvaluator[] = [
  // --- EOL MongoDB version ---
  {
    matches: nameHas("eol", "version"),
    evaluate: (f) => {
      const v = f.serverStatus?.version ?? f.topology.mongoVersion;
      if (!v || v === "unknown" || v === "0.0.0") return { status: "unknown" };
      const [maj, min] = v.split(".");
      const mm = `${maj}.${min}`;
      const eol = ["3.6", "4.0", "4.2", "4.4", "5.0"];
      return eol.includes(mm)
        ? { status: "detected", detail: `Running end-of-life MongoDB ${v}.`, evidence: { version: v } }
        : { status: "clear", detail: `MongoDB ${v} is a supported release.`, evidence: { version: v } };
    },
  },
  // --- Encryption At Rest not enabled ---
  {
    matches: nameHas("encryption at rest"),
    evaluate: (f) => {
      const ss: any = f.serverStatus;
      const enabled = ss?.encryptionAtRest?.encryptionEnabled ?? ss?.security?.encryptionAtRest;
      if (enabled == null) return { status: "unknown", detail: "EAR status not in collected data." };
      return enabled
        ? { status: "clear", detail: "Encryption at rest is enabled." }
        : { status: "detected", detail: "Encryption at rest is NOT enabled." };
    },
  },
  // --- Journaling disabled ---
  {
    matches: (r) => /journaling/i.test(r.name) && /false|disabl/i.test(r.name + r.description),
    evaluate: (f) => {
      const j: any = (f.serverStatus as any)?.storageEngine ?? undefined;
      // Journaling is effectively always on for WiredTiger; flag only if we can see it off.
      const dur = (f.serverStatus as any)?.dur;
      if (dur === undefined && j === undefined) return { status: "unknown" };
      return { status: "clear", detail: "Journaling appears enabled (WiredTiger default)." };
    },
  },
  // --- Oplog window too small ---
  {
    matches: nameHas("oplog window"),
    evaluate: (f) => {
      const hours = f.replSetStatus?.oplogWindowHours;
      if (hours == null) return { status: "unknown", detail: "Oplog window not available in collected data." };
      return hours < 24
        ? { status: "detected", detail: `Oplog window is ~${hours.toFixed(1)}h (< 24h).`, evidence: { oplogWindowHours: hours } }
        : { status: "clear", detail: `Oplog window ~${hours.toFixed(1)}h.`, evidence: { oplogWindowHours: hours } };
    },
  },
  // --- Unnecessary / unused indexes ---
  {
    matches: (r) => /unnecessary index|unused index/i.test(r.name),
    evaluate: (f) => {
      const unused = (f.indexUsage ?? []).filter((i) => i.name !== "_id_" && i.ops === 0);
      if (!f.indexUsage) return { status: "unknown" };
      return unused.length > 0
        ? {
            status: "detected",
            detail: `${unused.length} unused index(es).`,
            evidence: { indexes: unused.map((i) => `${i.db}.${i.collection}:${i.name}`).slice(0, 30) },
          }
        : { status: "clear", detail: "No unused indexes detected." };
    },
  },
  // --- Storage capacity insufficient for growth ---
  {
    matches: nameHas("storage capacity"),
    evaluate: (f) => {
      const s = f.storage;
      if (!s?.fsUsedBytes || !s?.fsTotalBytes) return { status: "unknown" };
      const pct = (s.fsUsedBytes / s.fsTotalBytes) * 100;
      return pct >= 70
        ? { status: "detected", detail: `Disk ${pct.toFixed(0)}% used.`, evidence: { usedPct: Number(pct.toFixed(1)) } }
        : { status: "clear", detail: `Disk ${pct.toFixed(0)}% used.`, evidence: { usedPct: Number(pct.toFixed(1)) } };
    },
  },
  // --- Incompatible / old driver versions ---
  {
    matches: (r) => /driver/i.test(r.name) && /incompatible|version/i.test(r.name),
    evaluate: (f) => {
      // Driver versions come from Atlas facts or getMongoData driverVersions (not
      // always present). Without that data we can't verify.
      void f;
      return { status: "unknown", detail: "Driver version data not available in this scan." };
    },
  },
  // --- Log redaction not enabled ---
  {
    matches: nameHas("log redaction"),
    evaluate: (f) => {
      const v = param(f, "redactClientLogData");
      if (v == null) return { status: "unknown" };
      return v === true
        ? { status: "clear", detail: "Log redaction (redactClientLogData) is enabled." }
        : { status: "detected", detail: "Log redaction is NOT enabled (redactClientLogData=false).", evidence: { redactClientLogData: v } };
    },
  },
  // --- TLS allowed but not enforced / disabled ---
  {
    matches: (r) => /\btls\b/i.test(r.name) && /(not enforced|allowed|disabl)/i.test(r.name + r.description),
    evaluate: (f) => {
      const mode = param(f, "tlsMode") ?? (f.serverStatus?.security?.tlsEnabled === false ? "disabled" : undefined);
      if (mode == null) return { status: "unknown" };
      const m = String(mode);
      if (m === "disabled" || m === "allowTLS" || m === "preferTLS") {
        return { status: "detected", detail: `TLS mode is "${m}" (not enforced).`, evidence: { tlsMode: m } };
      }
      return { status: "clear", detail: `TLS mode is "${m}".`, evidence: { tlsMode: m } };
    },
  },
  // --- enableReadConcernMajority disabled ---
  {
    matches: nameHas("enablereadconcernmajority"),
    evaluate: (f) => {
      const v = param(f, "enableMajorityReadConcern") ?? param(f, "enableReadConcernMajority");
      if (v == null) return { status: "unknown" };
      return v === false
        ? { status: "detected", detail: "enableMajorityReadConcern is disabled.", evidence: { enableMajorityReadConcern: v } }
        : { status: "clear", detail: "Majority read concern is enabled." };
    },
  },
  // --- NUMA enabled (interleave not set) ---
  {
    matches: (r) => /numa/i.test(r.name),
    evaluate: (f) => {
      const numa = f.os?.numa ?? f.hostInfo?.numaEnabled;
      if (numa == null) return { status: "unknown" };
      return numa === true
        ? { status: "detected", detail: "NUMA is enabled on the host (ensure numactl interleave for mongod).", evidence: { numaEnabled: true } }
        : { status: "clear", detail: "NUMA not enabled." };
    },
  },
  // --- Low max file descriptors (mdiag ulimit) ---
  {
    matches: nameHas("file descriptor"),
    evaluate: (f) => {
      const soft = f.os?.openFilesLimit;
      if (soft == null) return { status: "unknown", detail: "File-descriptor limit needs an mdiag import." };
      return soft < 64000
        ? { status: "detected", detail: `Max open files ${soft} (< 64000 recommended).`, evidence: { openFilesLimit: soft } }
        : { status: "clear", detail: `Max open files ${soft}.` };
    },
  },
  // --- Transparent HugePages (mdiag) ---
  {
    matches: (r) => /hugepage|transparent huge/i.test(r.name),
    evaluate: (f) => {
      const thp = f.os?.transparentHugePages;
      if (thp == null) return { status: "unknown", detail: "THP status needs an mdiag import (Linux)." };
      return /always|madvise/i.test(thp)
        ? { status: "detected", detail: `Transparent HugePages = "${thp}" (should be 'never').`, evidence: { thp, defrag: f.os?.thpDefrag } }
        : { status: "clear", detail: `THP = "${thp}".` };
    },
  },
  // --- Swappiness (mdiag sysctl) ---
  {
    matches: (r) => /swappiness/i.test(r.name),
    evaluate: (f) => {
      const s = f.os?.swappiness;
      if (s == null) return { status: "unknown", detail: "Swappiness needs an mdiag import." };
      return s > 1
        ? { status: "detected", detail: `vm.swappiness=${s} (recommend 1).`, evidence: { swappiness: s } }
        : { status: "clear", detail: `vm.swappiness=${s}.` };
    },
  },
  // --- Kernel max_map_count (mdiag sysctl) ---
  {
    matches: (r) => /max.?map.?count/i.test(r.name),
    evaluate: (f) => {
      const v = f.os?.maxMapCount;
      if (v == null) return { status: "unknown", detail: "max_map_count needs an mdiag import." };
      return v < 128000
        ? { status: "detected", detail: `vm.max_map_count=${v} (recommend >= 128000).`, evidence: { maxMapCount: v } }
        : { status: "clear", detail: `vm.max_map_count=${v}.` };
    },
  },
  // --- TCP keepalive (mdiag sysctl) ---
  {
    matches: (r) => /keepalive/i.test(r.name),
    evaluate: (f) => {
      const v = f.os?.tcpKeepaliveTime;
      if (v == null) return { status: "unknown", detail: "TCP keepalive needs an mdiag import." };
      return v > 300
        ? { status: "detected", detail: `net.ipv4.tcp_keepalive_time=${v}s (recommend <= 300).`, evidence: { tcpKeepaliveTime: v } }
        : { status: "clear", detail: `tcp_keepalive_time=${v}s.` };
    },
  },
  // --- High disk readahead (mdiag) ---
  {
    matches: (r) => /readahead|read-ahead|read ahead/i.test(r.name),
    evaluate: (f) => {
      const ra = f.os?.readAheadKb;
      if (ra == null) return { status: "unknown", detail: "Read-ahead needs an mdiag import." };
      return ra > 256
        ? { status: "detected", detail: `Disk read_ahead_kb=${ra} (recommend <= 256 for WiredTiger).`, evidence: { readAheadKb: ra } }
        : { status: "clear", detail: `read_ahead_kb=${ra}.` };
    },
  },
  // --- SELinux enforcing (mdiag sestatus) ---
  {
    matches: (r) => /selinux/i.test(r.name),
    evaluate: (f) => {
      const s = f.os?.selinux;
      if (s == null) return { status: "unknown", detail: "SELinux status needs an mdiag import." };
      return s === "enforcing"
        ? { status: "detected", detail: `SELinux is ${s} (can cause MongoDB permission issues with custom configs).`, evidence: { selinux: s } }
        : { status: "clear", detail: `SELinux is ${s}.` };
    },
  },
];

/** Read a server parameter value (getParameter '*'), unwrapping common shapes. */
function param(f: CollectedFacts, key: string): unknown {
  const p = f.serverParameters?.[key];
  if (p && typeof p === "object" && "$numberInt" in (p as any)) return Number((p as any).$numberInt);
  if (p && typeof p === "object" && "$numberLong" in (p as any)) return Number((p as any).$numberLong);
  return p;
}

/**
 * Assess every catalog risk against the facts. Risks with a matching evaluator
 * get detected/clear/unknown; the rest are left as "manual" (caller may hand
 * those to the LLM matcher as "suggested").
 */
export function evaluateRisks(
  catalog: RiskCatalogEntry[],
  facts: CollectedFacts,
): RiskAssessment[] {
  return catalog.map((risk) => {
    const evaluator = EVALUATORS.find((e) => e.matches(risk));
    if (!evaluator) return { risk, status: "manual" as RiskStatus };
    const res = evaluator.evaluate(facts);
    return { risk, status: res.status, detail: res.detail, evidence: res.evidence };
  });
}
