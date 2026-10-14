import type { Finding, HealthScore, Severity } from "../core/types.js";

/** Penalty applied to the 0-100 score per finding of each severity. */
const PENALTY: Record<Severity, number> = {
  ok: 0,
  info: 2,
  warning: 8,
  critical: 25,
};

/**
 * Deterministic health score. Starts at 100 and subtracts penalties.
 * A single critical can drop the score substantially; many infos erode it
 * gradually. Bounded to [0, 100].
 */
export function scoreFindings(findings: Finding[]): HealthScore {
  const counts: Record<Severity, number> = { ok: 0, info: 0, warning: 0, critical: 0 };
  let value = 100;
  for (const f of findings) {
    counts[f.severity]++;
    value -= PENALTY[f.severity];
  }
  return { value: Math.max(0, Math.min(100, value)), counts };
}
