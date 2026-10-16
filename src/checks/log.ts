import type { Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/**
 * Checks derived from an imported `mongod.log` (facts.log). These turn log
 * signals into findings so they contribute to the health score. All are no-ops
 * when no log was imported (facts.log undefined), so they never affect
 * live/online scans that lack log data.
 */

/** Fatal log lines (severity "F") and assertions — the most severe signal. */
register({
  id: "log.fatal-errors",
  category: "availability",
  title: "Fatal errors in mongod.log",
  evaluate({ facts }: CheckContext): Finding[] {
    const log = facts.log;
    if (!log) return [];
    const fatal = log.fatalCount + log.assertionCount;
    if (fatal === 0) return [];
    const top = (log.topErrors ?? [])[0];
    return [
      {
        checkId: "log.fatal-errors",
        category: "availability",
        severity: "critical",
        title: `${fatal} fatal error(s)/assertion(s) in mongod.log`,
        detail:
          `The log contains ${log.fatalCount} fatal line(s) and ${log.assertionCount} assertion(s), ` +
          `which indicate crashes or invariant failures.` +
          (top ? ` Most frequent error: "${top.msg}" (${top.count}×).` : ""),
        evidence: {
          fatalCount: log.fatalCount,
          assertionCount: log.assertionCount,
          topErrors: log.topErrors,
          window: windowOf(log),
        },
        remediation:
          "Investigate the fatal lines and surrounding context; check for OOM kills, disk full, or corruption.",
        docs: "https://www.mongodb.com/docs/manual/reference/log-messages/",
      },
    ];
  },
});

/** Elevated error rate (severity "E") over the log window. */
register({
  id: "log.error-rate",
  category: "configuration",
  title: "Errors logged by mongod",
  evaluate({ facts }: CheckContext): Finding[] {
    const log = facts.log;
    if (!log || log.errorCount === 0) return [];
    const top = (log.topErrors ?? []).filter((e) => e.msg);
    const severity = log.errorCount >= 50 ? "warning" : "info";
    return [
      {
        checkId: "log.error-rate",
        category: "configuration",
        severity,
        title: `${log.errorCount} error line(s) in mongod.log`,
        detail:
          `mongod logged ${log.errorCount} error(s) over the captured window.` +
          (top[0] ? ` Most frequent: "${top[0].msg}" (${top[0].count}×).` : ""),
        evidence: {
          errorCount: log.errorCount,
          totalLines: log.totalLines,
          topErrors: log.topErrors,
          window: windowOf(log),
        },
        docs: "https://www.mongodb.com/docs/manual/reference/log-messages/",
      },
    ];
  },
});

/** Frequent replica-set elections — instability / failover churn. */
register({
  id: "log.frequent-elections",
  category: "replication",
  title: "Frequent replica-set elections",
  evaluate({ facts }: CheckContext): Finding[] {
    const log = facts.log;
    if (!log || log.electionCount === 0) return [];
    // A couple of elections over a long window is normal; many indicate churn.
    if (log.electionCount < 3) return [];
    const severity = log.electionCount >= 10 ? "warning" : "info";
    return [
      {
        checkId: "log.frequent-elections",
        category: "replication",
        severity,
        title: `${log.electionCount} replica-set elections in mongod.log`,
        detail:
          `Repeated elections (${log.electionCount}) and ${log.stateChangeCount} state change(s) suggest ` +
          `failover churn — possible network partitions, overloaded primaries, or flapping nodes.`,
        evidence: {
          electionCount: log.electionCount,
          stateChangeCount: log.stateChangeCount,
          window: windowOf(log),
        },
        remediation:
          "Check network stability between members, primary load, and heartbeat/election timeouts.",
        docs: "https://www.mongodb.com/docs/manual/core/replica-set-elections/",
      },
    ];
  },
});

/** Unexpected restarts / unclean shutdowns. */
register({
  id: "log.unclean-shutdown",
  category: "availability",
  title: "Unclean shutdowns / restarts",
  evaluate({ facts }: CheckContext): Finding[] {
    const log = facts.log;
    if (!log) return [];
    // More than one startup in a single log, or an explicit unclean shutdown.
    if (log.uncleanShutdownCount === 0 && log.startupCount <= 1) return [];
    const restarts = Math.max(0, log.startupCount - 1);
    if (restarts === 0 && log.uncleanShutdownCount === 0) return [];
    const severity = log.uncleanShutdownCount > 0 ? "warning" : "info";
    return [
      {
        checkId: "log.unclean-shutdown",
        category: "availability",
        severity,
        title: `${restarts} restart(s), ${log.uncleanShutdownCount} unclean shutdown(s)`,
        detail:
          `The log spans ${log.startupCount} process startup(s)` +
          (log.uncleanShutdownCount > 0
            ? ` including ${log.uncleanShutdownCount} unclean shutdown(s) (signals/fatal termination).`
            : `, indicating the process restarted during the captured window.`),
        evidence: {
          startupCount: log.startupCount,
          restarts,
          uncleanShutdownCount: log.uncleanShutdownCount,
          window: windowOf(log),
        },
        remediation:
          "Correlate restarts with OS logs (OOM killer, systemd) and check for crashes or operator restarts.",
      },
    ];
  },
});

/** WiredTiger / storage warnings in the log. */
register({
  id: "log.storage-warnings",
  category: "configuration",
  title: "Storage/WiredTiger warnings in mongod.log",
  evaluate({ facts }: CheckContext): Finding[] {
    const log = facts.log;
    if (!log || log.storageWarningCount === 0) return [];
    const severity = log.storageWarningCount >= 20 ? "warning" : "info";
    return [
      {
        checkId: "log.storage-warnings",
        category: "configuration",
        severity,
        title: `${log.storageWarningCount} storage/WiredTiger warning(s)`,
        detail:
          `The storage engine logged ${log.storageWarningCount} warning/error line(s). ` +
          `These can precede cache pressure, checkpoint stalls, or disk issues.`,
        evidence: {
          storageWarningCount: log.storageWarningCount,
          window: windowOf(log),
        },
        docs: "https://www.mongodb.com/docs/manual/core/wiredtiger/",
      },
    ];
  },
});

/** Compact ISO window descriptor for finding evidence. */
function windowOf(log: { firstTs?: string; lastTs?: string }): string | undefined {
  if (log.firstTs && log.lastTs) return `${log.firstTs} → ${log.lastTs}`;
  return log.firstTs ?? log.lastTs;
}
