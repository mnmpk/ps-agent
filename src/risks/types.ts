/** One entry from the expert risk register (risks-catalog.json). */
export interface RiskCatalogEntry {
  id: string;
  level: "high" | "medium" | "low" | "unknown";
  status: string; // Active, Mitigated, Manifested, …
  probability: string;
  impact: string;
  name: string;
  description: string;
  recommendation: string;
  /** Whether this risk is evaluated. Disabled risks are skipped. Default true. */
  enabled?: boolean;
}

/** How a risk was assessed against a specific cluster's facts. */
export type RiskStatus =
  | "detected" // deterministic rule matched → the risk is present
  | "clear" // deterministic rule ran and did NOT match → not present
  | "manual" // not auto-detectable; needs human review
  | "suggested" // LLM flagged it as possibly applicable (advisory, unverified)
  | "unknown"; // couldn't evaluate (missing data)

export interface RiskAssessment {
  risk: RiskCatalogEntry;
  status: RiskStatus;
  /** Evidence for detected/clear (deterministic) or the LLM's rationale (suggested). */
  detail?: string;
  evidence?: Record<string, unknown>;
  /** For "suggested": the model's confidence 0–1. */
  confidence?: number;
}

export interface RiskReport {
  generatedAt: string;
  sourceId: string;
  counts: {
    detected: number;
    clear: number;
    manual: number;
    suggested: number;
    unknown: number;
  };
  assessments: RiskAssessment[];
  /**
   * Cache metadata (set by the service layer). `cached` is true when this report
   * was served from the last stored run rather than recomputed; `cachedAt` is
   * when it was originally computed (ISO). Absent on a freshly computed report.
   */
  cached?: boolean;
  cachedAt?: string;
}
