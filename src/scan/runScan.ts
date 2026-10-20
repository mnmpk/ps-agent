import type { Source } from "../core/source.js";
import type { ScanResult } from "../core/types.js";
import { DirectCollector } from "../collectors/direct/directCollector.js";
import type { Collector } from "../collectors/collector.js";
import {
  DEFAULT_THRESHOLDS,
  runChecks,
  scoreFindings,
  type Thresholds,
} from "../checks/index.js";
import { SEVERITY_RANK } from "../core/types.js";

function collectorFor(source: Source): Collector {
  if (source.connectionString) return new DirectCollector(source);
  throw new Error(
    "Legacy runScan supports a direct connection string only; use runGraphScan for other inputs.",
  );
}

/**
 * Deterministic pipeline: collect facts → run rule engine → score.
 * (The LLM correlate/summarize step is a later phase and sits on top of this.)
 */
export async function runScan(
  source: Source,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<ScanResult> {
  const startedAt = new Date();
  const collector = collectorFor(source);
  try {
    const facts = await collector.collect();
    const findings = runChecks({ facts, thresholds }).sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
    const score = scoreFindings(findings);
    return {
      sourceId: source.id,
      sourceName: source.name,
      startedAt,
      finishedAt: new Date(),
      facts,
      findings,
      score,
    };
  } finally {
    await collector.close();
  }
}
