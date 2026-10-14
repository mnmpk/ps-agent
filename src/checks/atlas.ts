import type { AtlasMeasurement, AtlasProcess, Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

function metric(proc: AtlasProcess, name: string): AtlasMeasurement | undefined {
  return proc.measurements.find((m) => m.name === name);
}

/** Open Atlas alerts surfaced directly as findings. */
register({
  id: "atlas.open-alerts",
  category: "availability",
  title: "Open Atlas alerts",
  evaluate({ facts }: CheckContext): Finding[] {
    const atlas = facts.atlas;
    if (!atlas || atlas.openAlerts.length === 0) return [];
    return [
      {
        checkId: "atlas.open-alerts",
        category: "availability",
        severity: "warning",
        title: `${atlas.openAlerts.length} open Atlas alert(s)`,
        detail: `Atlas has open alerts: ${atlas.openAlerts
          .map((a) => a.eventTypeName)
          .slice(0, 10)
          .join(", ")}.`,
        evidence: {
          alerts: atlas.openAlerts.map((a) => ({ type: a.eventTypeName, status: a.status })),
        },
        remediation: "Review open alerts in the Atlas UI (Project → Alerts).",
      },
    ];
  },
});

/** Performance Advisor index suggestions. */
register({
  id: "atlas.suggested-indexes",
  category: "query",
  title: "Performance Advisor index suggestions",
  evaluate({ facts }: CheckContext): Finding[] {
    const atlas = facts.atlas;
    if (!atlas || atlas.suggestedIndexes.length === 0) return [];
    const top = [...atlas.suggestedIndexes].sort((a, b) => b.weight - a.weight).slice(0, 10);
    return [
      {
        checkId: "atlas.suggested-indexes",
        category: "query",
        severity: "warning",
        title: `${atlas.suggestedIndexes.length} index suggestion(s) from Performance Advisor`,
        detail:
          "Atlas Performance Advisor identified slow query shapes that would benefit from new indexes.",
        evidence: {
          suggestions: top.map((s) => ({ namespace: s.namespace, keys: s.keys, impact: s.weight })),
        },
        remediation: "Review and create the suggested indexes after validating against your workload.",
      },
    ];
  },
});

/** Sustained high CPU across Atlas processes. */
register({
  id: "atlas.cpu-saturation",
  category: "resource",
  title: "CPU saturation (Atlas)",
  evaluate({ facts }: CheckContext): Finding[] {
    const atlas = facts.atlas;
    if (!atlas) return [];
    const findings: Finding[] = [];
    for (const p of atlas.processes) {
      // Prefer normalized CPU (0-100% per core); fall back to raw if absent.
      const user =
        metric(p, "SYSTEM_NORMALIZED_CPU_USER")?.average ??
        metric(p, "SYSTEM_CPU_USER")?.average ??
        0;
      const kernel =
        metric(p, "SYSTEM_NORMALIZED_CPU_KERNEL")?.average ??
        metric(p, "SYSTEM_CPU_KERNEL")?.average ??
        0;
      const total = user + kernel;
      if (total < 80) continue;
      findings.push({
        checkId: "atlas.cpu-saturation",
        category: "resource",
        severity: total >= 90 ? "critical" : "warning",
        title: `${p.hostname} CPU averaging ${total.toFixed(0)}%`,
        detail: `Process ${p.id} averaged ${total.toFixed(1)}% CPU (user+kernel) over the window. Sustained high CPU risks latency and instability.`,
        evidence: { process: p.id, cpuUserAvg: user, cpuKernelAvg: kernel, totalAvg: total },
        remediation: "Investigate expensive queries/missing indexes or consider scaling the tier.",
      });
    }
    return findings;
  },
});

/** Query targeting ratio too high → missing/inefficient indexes. */
register({
  id: "atlas.query-targeting",
  category: "query",
  title: "Poor query targeting (Atlas)",
  evaluate({ facts }: CheckContext): Finding[] {
    const atlas = facts.atlas;
    if (!atlas) return [];
    const findings: Finding[] = [];
    for (const p of atlas.processes) {
      const scanned = metric(p, "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED");
      const ratio = scanned?.max ?? 0;
      if (ratio < 1000) continue;
      findings.push({
        checkId: "atlas.query-targeting",
        category: "query",
        severity: ratio >= 10000 ? "critical" : "warning",
        title: `${p.hostname} scanned ${Math.round(ratio)} objects per returned`,
        detail: `Query targeting peaked at ${Math.round(
          ratio,
        )} documents scanned per document returned, indicating collection scans or missing indexes.`,
        evidence: { process: p.id, scannedObjectsPerReturnedMax: ratio },
        remediation: "Use the Performance Advisor suggestions and add indexes for the hot query shapes.",
      });
    }
    return findings;
  },
});

/** Connections trending high relative to a nominal Atlas limit heuristic. */
register({
  id: "atlas.connections",
  category: "resource",
  title: "Connection growth (Atlas)",
  evaluate({ facts }: CheckContext): Finding[] {
    const atlas = facts.atlas;
    if (!atlas) return [];
    const findings: Finding[] = [];
    for (const p of atlas.processes) {
      const conns = metric(p, "CONNECTIONS");
      const peak = conns?.max ?? 0;
      // Heuristic threshold; real limit depends on tier. Flag notably high peaks.
      if (peak < 1500) continue;
      findings.push({
        checkId: "atlas.connections",
        category: "resource",
        severity: peak >= 4000 ? "warning" : "info",
        title: `${p.hostname} peaked at ${Math.round(peak)} connections`,
        detail: `Connection count peaked at ${Math.round(
          peak,
        )}. Compare against your tier's connection limit to ensure headroom.`,
        evidence: { process: p.id, connectionsMax: peak },
        remediation: "Right-size client connection pools and verify instance size limits.",
      });
    }
    return findings;
  },
});
