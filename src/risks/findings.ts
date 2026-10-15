import type { CollectedFacts, Finding, Severity } from "../core/types.js";
import { getActiveCatalog } from "./catalog.js";
import { evaluateRisks } from "./evaluators.js";

/**
 * Deterministically-detected risk-register entries as Finding[], so they appear
 * in the normal findings list / risk inbox alongside health-check findings.
 *
 * Only DETERMINISTIC "detected" assessments are included here (no LLM) — this
 * runs synchronously at scan time and must stay fast and reproducible. The
 * LLM-"suggested" matches remain exclusive to the on-demand Risk Register view.
 */
export function riskRegisterFindings(facts: CollectedFacts): Finding[] {
  const catalog = getActiveCatalog(); // enabled risks only
  const assessments = evaluateRisks(catalog, facts);
  const out: Finding[] = [];
  for (const a of assessments) {
    if (a.status !== "detected") continue;
    out.push({
      checkId: `register.${a.risk.id}`,
      category: "configuration",
      severity: levelToSeverity(a.risk.level),
      title: `[Risk Register] ${a.risk.name.split(":")[0]}`,
      detail: a.detail ?? a.risk.description.slice(0, 300),
      evidence: {
        riskId: a.risk.id,
        level: a.risk.level,
        ...(a.evidence ?? {}),
      },
      remediation: a.risk.recommendation || undefined,
    });
  }
  return out;
}

function levelToSeverity(level: string): Severity {
  if (level === "high") return "critical";
  if (level === "medium") return "warning";
  return "info";
}
