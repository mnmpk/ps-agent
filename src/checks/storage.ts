import type { Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/** Filesystem usage for the data partition (from MCP db-stats or driver). */
register({
  id: "storage.disk-usage",
  category: "resource",
  title: "Disk usage",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const s = facts.storage;
    if (!s || !s.fsUsedBytes || !s.fsTotalBytes) return [];
    const pct = s.fsUsedBytes / s.fsTotalBytes;
    if (pct < thresholds.diskUsageWarnPct) return [];
    const severity = pct >= thresholds.diskUsageCritPct ? "critical" : "warning";
    return [
      {
        checkId: "storage.disk-usage",
        category: "resource",
        severity,
        title: `Disk ${(pct * 100).toFixed(0)}% full`,
        detail: `Data partition is ${(pct * 100).toFixed(1)}% used (${gib(
          s.fsUsedBytes,
        )} of ${gib(s.fsTotalBytes)}). Running out of disk can halt writes.`,
        evidence: {
          fsUsedBytes: s.fsUsedBytes,
          fsTotalBytes: s.fsTotalBytes,
          usedPct: Number((pct * 100).toFixed(1)),
        },
        remediation: "Scale storage, archive/expire old data, or add a TTL policy.",
      },
    ];
  },
});

/** Index-to-data size ratio — a very high ratio suggests over-indexing. */
register({
  id: "storage.index-bloat",
  category: "query",
  title: "Index size vs data size",
  evaluate({ facts }: CheckContext): Finding[] {
    const s = facts.storage;
    if (!s || !s.dataSizeBytes || !s.indexSizeBytes) return [];
    if (s.dataSizeBytes === 0) return [];
    const ratio = s.indexSizeBytes / s.dataSizeBytes;
    if (ratio < 1) return []; // indexes larger than data → worth a look
    return [
      {
        checkId: "storage.index-bloat",
        category: "query",
        severity: "info",
        title: `Indexes exceed data size (${ratio.toFixed(1)}×)`,
        detail: `Total index size (${gib(s.indexSizeBytes)}) is ${ratio.toFixed(
          1,
        )}× the data size (${gib(s.dataSizeBytes)}), which can indicate over-indexing.`,
        evidence: {
          indexSizeBytes: s.indexSizeBytes,
          dataSizeBytes: s.dataSizeBytes,
          ratio: Number(ratio.toFixed(2)),
        },
        remediation: "Review indexes per collection and drop unused ones.",
      },
    ];
  },
});

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
