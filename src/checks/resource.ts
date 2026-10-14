import type { Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/** Connection pool nearing the available limit. */
register({
  id: "resource.connections",
  category: "resource",
  title: "Connection saturation",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    if (!facts.serverStatus) return [];
    const c = facts.serverStatus.connections;
    const total = c.current + c.available;
    if (total === 0) return [];
    const pct = c.current / total;
    if (pct < thresholds.connectionsWarnPct) return [];
    const severity = pct >= thresholds.connectionsCritPct ? "critical" : "warning";
    return [
      {
        checkId: "resource.connections",
        category: "resource",
        severity,
        title: `Connections at ${(pct * 100).toFixed(0)}% of limit`,
        detail: `${c.current} connections in use of ${total} available. Nearing the limit risks new connections being refused.`,
        evidence: { current: c.current, available: c.available, usedPct: Number((pct * 100).toFixed(1)) },
        remediation:
          "Review client connection-pool sizing (maxPoolSize) and look for connection leaks or too many app instances.",
      },
    ];
  },
});

/** WiredTiger concurrency tickets exhausted. */
register({
  id: "resource.tickets",
  category: "resource",
  title: "Concurrency tickets exhausted",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const t = facts.serverStatus?.tickets;
    if (!t) return [];
    const findings: Finding[] = [];
    if (t.readAvailable <= thresholds.ticketsWarnAvailable) {
      findings.push(ticketFinding("read", t.readAvailable, t.readOut));
    }
    if (t.writeAvailable <= thresholds.ticketsWarnAvailable) {
      findings.push(ticketFinding("write", t.writeAvailable, t.writeOut));
    }
    return findings;
  },
});

function ticketFinding(kind: "read" | "write", available: number, out: number): Finding {
  return {
    checkId: "resource.tickets",
    category: "resource",
    severity: available <= 0 ? "critical" : "warning",
    title: `${kind} concurrency tickets nearly exhausted (${available} left)`,
    detail: `Only ${available} ${kind} tickets available (${out} in use). When tickets hit zero, operations queue and latency spikes.`,
    evidence: { kind, available, out },
    remediation:
      "Indicates storage-engine saturation. Investigate slow operations, missing indexes, or undersized hardware.",
  };
}

/** WiredTiger cache dirty ratio high → eviction pressure. */
register({
  id: "resource.cache-dirty",
  category: "resource",
  title: "WiredTiger cache pressure",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const wt = facts.serverStatus?.wiredTigerCache;
    if (!wt || wt.maxBytes === 0) return [];
    const dirtyPct = wt.dirtyBytes / wt.maxBytes;
    if (dirtyPct < thresholds.cacheDirtyWarnPct) return [];
    return [
      {
        checkId: "resource.cache-dirty",
        category: "resource",
        severity: "warning",
        title: `WiredTiger cache ${(dirtyPct * 100).toFixed(0)}% dirty`,
        detail:
          "A high dirty-cache ratio indicates the storage engine cannot flush fast enough, which can stall writes.",
        evidence: {
          dirtyBytes: wt.dirtyBytes,
          maxBytes: wt.maxBytes,
          dirtyPct: Number((dirtyPct * 100).toFixed(1)),
        },
        remediation: "Check disk write throughput/IOPS and sustained write volume.",
      },
    ];
  },
});

/** Global lock queue building up. */
register({
  id: "resource.global-lock-queue",
  category: "resource",
  title: "Global lock queue",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const q = facts.serverStatus?.globalLockQueue;
    if (!q || q.total < thresholds.globalLockQueueWarn) return [];
    return [
      {
        checkId: "resource.global-lock-queue",
        category: "resource",
        severity: "warning",
        title: `${q.total} operations queued on the global lock`,
        detail: `${q.readers} readers and ${q.writers} writers are queued waiting for locks, indicating contention.`,
        evidence: { total: q.total, readers: q.readers, writers: q.writers },
      },
    ];
  },
});
