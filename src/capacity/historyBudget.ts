/**
 * History backfill budgeting.
 *
 * Pulling 90 days of per-hour metrics for many series can be a lot of data +
 * API calls. This helper takes a requested window/granularity and a per-metric
 * data-point budget, and returns a plan that respects the budget — coarsening
 * the granularity (PT1H → PT6H → P1D) before shortening the window — plus a
 * human-readable warning describing anything it reduced.
 */

export type Granularity = "PT1M" | "PT5M" | "PT1H" | "PT6H" | "P1D";

/** Granularities from fine → coarse, with their minutes-per-point. */
const GRAN_MINUTES: Array<[Granularity, number]> = [
  ["PT1M", 1],
  ["PT5M", 5],
  ["PT1H", 60],
  ["PT6H", 360],
  ["P1D", 1440],
];

export interface HistoryConfig {
  days: number;
  granularity: Granularity;
  /** Max data points per metric series (the budget). */
  maxPoints: number;
}

export interface HistoryPlan {
  days: number;
  granularity: Granularity;
  /** ISO-8601 period string for the Atlas API, e.g. "P90D". */
  period: string;
  /** Estimated points per metric for this plan. */
  estimatedPoints: number;
  /** Non-empty when the plan was reduced from the request. */
  warnings: string[];
}

export const DEFAULT_HISTORY: HistoryConfig = {
  days: numEnv("PS_AGENT_HISTORY_DAYS", 90),
  granularity: (process.env.PS_AGENT_HISTORY_GRANULARITY as Granularity) || "PT1H",
  maxPoints: numEnv("PS_AGENT_HISTORY_MAX_POINTS", 2400),
};

function granMinutes(g: Granularity): number {
  return GRAN_MINUTES.find(([k]) => k === g)?.[1] ?? 60;
}

function pointsFor(days: number, g: Granularity): number {
  return Math.ceil((days * 24 * 60) / granMinutes(g));
}

/**
 * Compute a backfill plan that fits within `maxPoints`. Strategy:
 *   1. Start at the requested granularity + window.
 *   2. If over budget, coarsen granularity step-by-step (keeps the full window).
 *   3. If still over at the coarsest granularity, shorten the window to fit.
 */
export function planHistory(config: HistoryConfig = DEFAULT_HISTORY): HistoryPlan {
  const warnings: string[] = [];
  let { days } = config;
  let granularity = config.granularity;

  const requestedPoints = pointsFor(days, granularity);
  if (requestedPoints > config.maxPoints) {
    // Coarsen granularity first.
    const startIdx = GRAN_MINUTES.findIndex(([k]) => k === granularity);
    for (let i = startIdx + 1; i < GRAN_MINUTES.length; i++) {
      const g = GRAN_MINUTES[i]![0];
      if (pointsFor(days, g) <= config.maxPoints) {
        granularity = g;
        break;
      }
      granularity = g; // keep coarsening to the end if needed
    }
    if (granularity !== config.granularity) {
      warnings.push(
        `History granularity coarsened from ${config.granularity} to ${granularity} ` +
          `to stay within the ${config.maxPoints}-point budget over ${days} days.`,
      );
    }
    // If still over budget at coarsest granularity, shorten the window.
    if (pointsFor(days, granularity) > config.maxPoints) {
      const maxDays = Math.floor((config.maxPoints * granMinutes(granularity)) / (24 * 60));
      warnings.push(
        `History window shortened from ${days} to ${maxDays} days ` +
          `(budget ${config.maxPoints} points at ${granularity}).`,
      );
      days = maxDays;
    }
  }

  return {
    days,
    granularity,
    period: `P${days}D`,
    estimatedPoints: pointsFor(days, granularity),
    warnings,
  };
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
