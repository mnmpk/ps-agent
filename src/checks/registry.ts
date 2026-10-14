import type { CollectedFacts, Category, Finding } from "../core/types.js";

/** Tunable thresholds; overridable per source later. */
export interface Thresholds {
  replicationLagWarningSec: number;
  replicationLagCriticalSec: number;
  connectionsWarnPct: number; // current / (current+available)
  connectionsCritPct: number;
  cacheDirtyWarnPct: number; // dirtyBytes / maxBytes
  ticketsWarnAvailable: number;
  globalLockQueueWarn: number;
  unusedIndexMinScanOps: number; // ops <= this → considered unused
  eolVersions: string[]; // major.minor strings considered end-of-life
  diskUsageWarnPct: number; // fsUsed / fsTotal
  diskUsageCritPct: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  replicationLagWarningSec: 30,
  replicationLagCriticalSec: 120,
  connectionsWarnPct: 0.8,
  connectionsCritPct: 0.95,
  cacheDirtyWarnPct: 0.2,
  ticketsWarnAvailable: 5,
  globalLockQueueWarn: 50,
  unusedIndexMinScanOps: 0,
  eolVersions: ["3.6", "4.0", "4.2", "4.4", "5.0"],
  diskUsageWarnPct: 0.8,
  diskUsageCritPct: 0.9,
};

export interface CheckContext {
  facts: CollectedFacts;
  thresholds: Thresholds;
}

export interface HealthCheck {
  id: string;
  category: Category;
  title: string;
  /** Returns zero or more findings. Empty array = healthy for this check. */
  evaluate(ctx: CheckContext): Finding[];
}

/** Ordered list of registered checks. New checks are appended here. */
const registry: HealthCheck[] = [];

export function register(check: HealthCheck): void {
  registry.push(check);
}

export function allChecks(): readonly HealthCheck[] {
  return registry;
}

export function runChecks(ctx: CheckContext): Finding[] {
  const findings: Finding[] = [];
  for (const check of registry) {
    try {
      findings.push(...check.evaluate(ctx));
    } catch (err) {
      findings.push({
        checkId: check.id,
        category: check.category,
        severity: "info",
        title: `Check "${check.id}" failed to run`,
        detail: (err as Error).message,
        evidence: {},
      });
    }
  }
  return findings;
}
