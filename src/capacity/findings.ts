import type { Finding } from "../core/types.js";
import type { CapacityReport } from "./types.js";

/**
 * Convert a CapacityReport into Finding[] so capacity issues show up alongside
 * health findings (risk inbox, dashboard, chat). Deterministic — evidence holds
 * the exact numbers; the LLM only narrates.
 */
export function capacityFindings(report: CapacityReport): Finding[] {
  const findings: Finding[] = [];

  // Disk projected to fill.
  const disk = report.growth.find((g) => g.metric.includes("DISK"));
  if (disk?.daysUntilFull != null) {
    const days = Math.round(disk.daysUntilFull);
    if (days < 365) {
      const severity = days < 14 ? "critical" : days < 60 ? "warning" : "info";
      findings.push({
        checkId: "capacity.disk-projected-full",
        category: "resource",
        severity,
        title: `Disk projected full in ~${days} days`,
        detail:
          `At the current growth of ${fmtBytes(disk.perWeek)}/week ` +
          `(R²=${disk.trend.r2.toFixed(2)}), the data partition is projected to fill ` +
          `around ${disk.projectedFullDate}.`,
        evidence: {
          perWeekBytes: Math.round(disk.perWeek),
          perWeekPct: disk.perWeekPct != null ? Number(disk.perWeekPct.toFixed(1)) : undefined,
          daysUntilFull: days,
          projectedFullDate: disk.projectedFullDate,
          r2: Number(disk.trend.r2.toFixed(2)),
        },
        remediation:
          "Enable/confirm disk auto-scaling, increase disk size, or archive/expire old data (TTL).",
      });
    }
  }

  // Scale-up recommended.
  if (report.scale.direction === "up") {
    findings.push({
      checkId: "capacity.scale-up-recommended",
      category: "resource",
      severity: "warning",
      title:
        `Scale up recommended${report.scale.targetTier ? ` → ${report.scale.targetTier}` : ""}`,
      detail: report.scale.rationale,
      evidence: {
        drivers: report.scale.drivers,
        factor: report.scale.factor,
        currentTier: report.scale.currentTier,
        targetTier: report.scale.targetTier,
        confidence: report.scale.confidence,
      },
      remediation: report.scale.targetTier
        ? `Consider scaling the cluster tier up to ${report.scale.targetTier}.`
        : "Consider a larger cluster tier.",
    });
  }

  // Query-layer bottleneck (slow queries / COLLSCANs / poor targeting).
  const topQuery = report.bottlenecks.find((b) => b.kind === "query");
  if (topQuery) {
    const ev = topQuery.evidence as {
      namespace?: string;
      collscanCount?: number;
      worstScannedPerReturned?: number;
    };
    const severity =
      (ev.collscanCount ?? 0) > 0 || (ev.worstScannedPerReturned ?? 0) >= 1000
        ? "warning"
        : "info";
    findings.push({
      checkId: "bottleneck.slow-queries",
      category: "query",
      severity,
      title: `Slow-query bottleneck on ${ev.namespace ?? "a namespace"}`,
      detail: topQuery.detail,
      evidence: topQuery.evidence,
      remediation:
        "Review the Performance Advisor suggested indexes and add indexes for the hot query shapes.",
    });
  }

  // Scale-down (cost optimization) opportunity.
  if (report.scale.direction === "down") {
    findings.push({
      checkId: "capacity.underutilized",
      category: "resource",
      severity: "info",
      title:
        `Underutilized — cost optimization possible${report.scale.targetTier ? ` → ${report.scale.targetTier}` : ""}`,
      detail: report.scale.rationale,
      evidence: {
        drivers: report.scale.drivers,
        currentTier: report.scale.currentTier,
        targetTier: report.scale.targetTier,
        confidence: report.scale.confidence,
      },
      remediation: report.scale.targetTier
        ? `Evaluate scaling down to ${report.scale.targetTier} to reduce cost (validate against peak load first).`
        : "Evaluate a smaller cluster tier to reduce cost.",
    });
  }

  return findings;
}

function fmtBytes(b: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = Math.abs(b);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(b < 0 ? -v : v).toFixed(v < 10 && i > 0 ? 2 : 0)} ${u[i]}`;
}
