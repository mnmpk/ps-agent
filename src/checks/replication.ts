import type { Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/** Secondary replication lag versus the primary's optime. */
register({
  id: "repl.lag",
  category: "replication",
  title: "Replication lag",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const repl = facts.replSetStatus;
    if (!repl) return [];
    const primary = repl.members.find((m) => m.state === 1);
    if (!primary?.optimeDate) return [];

    const findings: Finding[] = [];
    for (const m of repl.members) {
      if (m.state !== 2 || !m.optimeDate) continue; // only SECONDARY
      const lagSec = Math.max(
        0,
        (primary.optimeDate.getTime() - m.optimeDate.getTime()) / 1000,
      );
      if (lagSec < thresholds.replicationLagWarningSec) continue;
      const severity =
        lagSec >= thresholds.replicationLagCriticalSec ? "critical" : "warning";
      findings.push({
        checkId: "repl.lag",
        category: "replication",
        severity,
        title: `Secondary ${m.name} lagging ${Math.round(lagSec)}s`,
        detail: `Secondary ${m.name} is ${Math.round(
          lagSec,
        )}s behind the primary's optime. Lagging secondaries weaken read scaling and majority write durability.`,
        evidence: {
          member: m.name,
          lagSeconds: Math.round(lagSec),
          warningThreshold: thresholds.replicationLagWarningSec,
          criticalThreshold: thresholds.replicationLagCriticalSec,
        },
        remediation:
          "Check secondary host I/O, network throughput, and whether a large batch operation is in progress.",
      });
    }
    return findings;
  },
});
