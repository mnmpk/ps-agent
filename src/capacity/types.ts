/**
 * Types for the capacity / growth / utilization engine (deterministic).
 * These are computed from stored metric series + the cluster spec. The LLM
 * only narrates them; it never invents the numbers.
 */

/** A linear fit over a series, with confidence. */
export interface Trend {
  /** Slope in value-units per DAY. */
  perDay: number;
  /** Coefficient of determination (0–1); higher = more confident/linear. */
  r2: number;
  /** Number of points used. */
  points: number;
  /** Span of the fitted window, in days. */
  spanDays: number;
  /** Most recent observed value. */
  latest: number;
}

/** Growth analysis for a cumulative metric (e.g. disk used). */
export interface GrowthAnalysis {
  metric: string;
  units: string;
  trend: Trend;
  /** Growth per week in the metric's units. */
  perWeek: number;
  /** Growth per week as a percentage of the latest value. */
  perWeekPct?: number;
  /** For disk: days until the partition is full, if a limit is known. */
  daysUntilFull?: number;
  /** Projected date the partition fills, if applicable. */
  projectedFullDate?: string;
}

/** Current + p95 utilization of one resource against its limit. */
export interface ResourceUtilization {
  resource: "cpu" | "memory" | "disk" | "iops" | "connections";
  /** Human label, e.g. "CPU", "Disk space", "Disk IOPS". */
  label: string;
  /** Current/latest utilization as a fraction 0–1 of the limit. */
  current?: number;
  /** p95 utilization over the window, 0–1. */
  p95?: number;
  /** The raw latest value and the limit, for display. */
  latestValue?: number;
  limitValue?: number;
  units?: string;
  /** True when the limit is unknown (e.g. direct source without tier info). */
  unbounded?: boolean;
}

export type ScaleDirection = "up" | "out" | "down" | "none";

export interface ScaleRecommendation {
  direction: ScaleDirection;
  /**
   * Multiplicative headroom factor driving the recommendation. For scale-up:
   * how much more capacity is needed to bring peak utilization under target
   * (e.g. 1.6 = need ~60% more). For scale-down: how much spare exists.
   */
  factor?: number;
  /** Suggested target tier, if we can name one (Atlas). */
  targetTier?: string;
  currentTier?: string;
  /** The resource(s) driving the recommendation. */
  drivers: string[];
  /** Human rationale (also narrated by the LLM). */
  rationale: string;
  /** Confidence: how much data/signal backs this (0–1). */
  confidence: number;
}

/** One ranked bottleneck candidate. */
export interface BottleneckSignal {
  resource: string;
  /** 0–1 severity score combining closeness-to-limit and trend. */
  score: number;
  detail: string;
  evidence: Record<string, unknown>;
  /** "resource" = CPU/disk/etc.; "query" = slow-query/index signal. */
  kind?: "resource" | "query";
}

/**
 * Aggregated slow-query signal for one namespace (from Performance Advisor
 * slow-query logs + namespaces). Extracted deterministically from log lines.
 */
export interface QuerySignal {
  namespace: string;
  /** Count of slow queries seen for this namespace. */
  slowCount: number;
  /** Count of those that were collection scans (COLLSCAN). */
  collscanCount: number;
  /** Worst docsExamined-per-returned ratio observed (query targeting). */
  worstScannedPerReturned: number;
  /** Max observed duration (ms). */
  maxDurationMs: number;
  /** A representative example operation (redacted shape, not values). */
  example?: string;
}

export interface CapacityReport {
  generatedAt: string;
  /** Whether limits were known (Atlas spec) or the analysis is unbounded. */
  hasLimits: boolean;
  growth: GrowthAnalysis[];
  utilization: ResourceUtilization[];
  scale: ScaleRecommendation;
  /** Top bottleneck signals (deterministic; expanded in 8c). */
  bottlenecks: BottleneckSignal[];
  /** Window used for the analysis, in days. */
  windowDays: number;
  /** Non-fatal notes (e.g. insufficient history, unknown limits). */
  notes: string[];
}
