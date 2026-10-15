import { END, START, StateGraph } from "@langchain/langgraph";
import { HealthScanState, type HealthScanStateType } from "../state.js";
import { DirectCollector } from "../../collectors/direct/directCollector.js";
import { AtlasCollector } from "../../collectors/atlas/atlasCollector.js";
import { McpCollector } from "../../collectors/mcp/mcpCollector.js";
import { OpsManagerCollector } from "../../collectors/opsmanager/opsManagerCollector.js";
import type { Collector } from "../../collectors/collector.js";
import {
  runChecks,
  scoreFindings,
} from "../../checks/index.js";
import { SEVERITY_RANK, type ScanResult, type CollectedFacts as CollectedFactsType } from "../../core/types.js";
import type { Source } from "../../core/source.js";
import { createChatModelFromEnv, llmConfigFromEnv } from "../llm.js";
import { correlateAndRank, fallbackAnalysis } from "../correlate.js";
import type { ScanStore } from "../../store/store.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../../checks/index.js";
import { bus } from "../../events/bus.js";
import { riskRegisterFindings } from "../../risks/findings.js";

/** Merge a source's partial threshold overrides onto the defaults. */
export function resolveThresholds(source: Source): Thresholds {
  if (!source.thresholdOverrides) return DEFAULT_THRESHOLDS;
  return { ...DEFAULT_THRESHOLDS, ...source.thresholdOverrides };
}

function collectorFor(source: Source): Collector {
  switch (source.kind) {
    case "direct":
      return new DirectCollector(source);
    case "atlas":
      return new AtlasCollector(source);
    case "mcp":
      return new McpCollector(source);
    case "opsmanager":
      return new OpsManagerCollector(source);
    case "offline":
      throw new Error(
        "Offline sources are updated by importing a getMongoData log, not by scanning.",
      );
  }
}

// --- nodes -----------------------------------------------------------------

/** collect_facts: gather raw facts (no judgement). */
async function collectFacts(
  state: HealthScanStateType,
): Promise<Partial<HealthScanStateType>> {
  const collector = collectorFor(state.source);
  try {
    const facts = await collector.collect();
    return { facts };
  } finally {
    await collector.close();
  }
}

/** run_rule_engine: deterministic findings + score (no LLM). */
function runRuleEngine(
  state: HealthScanStateType,
): Partial<HealthScanStateType> {
  if (!state.facts) throw new Error("runRuleEngine called before facts were collected");
  const findings = [
    ...runChecks({ facts: state.facts, thresholds: state.thresholds }),
    ...riskRegisterFindings(state.facts), // detected expert-register risks
  ].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const score = scoreFindings(findings);
  return { findings, score };
}

/** correlate_and_rank: LLM narration (or deterministic fallback). */
async function correlate(
  state: HealthScanStateType,
): Promise<Partial<HealthScanStateType>> {
  if (!state.facts || !state.score) throw new Error("correlate called before rule engine");

  if (!state.summarize) {
    return { analysis: fallbackAnalysis(state.findings, state.score) };
  }

  const model = await createChatModelFromEnv();
  if (!model) {
    // Requested summarization but no provider available — degrade gracefully.
    return { analysis: fallbackAnalysis(state.findings, state.score) };
  }

  const cfg = llmConfigFromEnv();
  const generatedBy = cfg ? `${cfg.provider}:${cfg.model}` : "unknown";
  try {
    const analysis = await correlateAndRank(
      model,
      {
        sourceName: state.source.name,
        host:
          state.facts.serverStatus?.host ??
          (state.facts.atlas ? `Atlas:${state.facts.atlas.projectId}` : "unknown"),
        topology: state.facts.topology,
        findings: state.findings,
        score: state.score,
      },
      generatedBy,
      cfg?.provider,
    );
    return { analysis };
  } catch (err) {
    // Never let an LLM failure fail a health scan; fall back deterministically.
    const fallback = fallbackAnalysis(state.findings, state.score);
    fallback.summary = `[LLM summarization failed: ${(err as Error).message}] ${fallback.summary}`;
    return { analysis: fallback };
  }
}

// --- graph -----------------------------------------------------------------

export function buildHealthScanGraph() {
  const graph = new StateGraph(HealthScanState)
    .addNode("collect_facts", collectFacts)
    .addNode("run_rule_engine", runRuleEngine)
    .addNode("correlate_and_rank", correlate)
    .addEdge(START, "collect_facts")
    .addEdge("collect_facts", "run_rule_engine")
    .addEdge("run_rule_engine", "correlate_and_rank")
    .addEdge("correlate_and_rank", END);
  return graph.compile();
}

/**
 * Build a ScanResult from already-collected facts (no live collection). Used by
 * the offline importer — runs the deterministic rule engine + score on facts
 * parsed from a getMongoData log.
 */
export function scoreFactsToScan(
  source: Source,
  facts: CollectedFactsType,
): ScanResult {
  const now = new Date();
  const findings = [
    ...runChecks({ facts, thresholds: resolveThresholds(source) }),
    ...riskRegisterFindings(facts),
  ].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const score = scoreFindings(findings);
  return {
    sourceId: source.id,
    sourceName: source.name,
    startedAt: now,
    finishedAt: now,
    facts,
    findings,
    score,
  };
}

export interface RunGraphScanOptions {
  summarize?: boolean;
  store?: ScanStore;
  /** Emit scan.started/completed/failed on the shared event bus. */
  emitEvents?: boolean;
}

/**
 * Convenience runner: executes the graph and shapes the output into a
 * ScanResult, optionally persisting a snapshot and emitting lifecycle events.
 */
export async function runGraphScan(
  source: Source,
  options: RunGraphScanOptions = {},
): Promise<ScanResult> {
  const startedAt = new Date();
  if (options.emitEvents) {
    bus.publish({
      type: "scan.started",
      sourceId: source.id,
      sourceName: source.name,
      at: startedAt.toISOString(),
    });
  }

  try {
    const app = buildHealthScanGraph();
    const final = await app.invoke({
      source,
      thresholds: resolveThresholds(source),
      summarize: options.summarize ?? false,
    });

    if (!final.facts || !final.score) {
      throw new Error("Scan graph produced incomplete state");
    }

    const result: ScanResult = {
      sourceId: source.id,
      sourceName: source.name,
      startedAt,
      finishedAt: new Date(),
      facts: final.facts,
      findings: final.findings,
      score: final.score,
      analysis: final.analysis,
    };

    if (options.store) {
      await options.store.saveScan(result);
    }

    if (options.emitEvents) {
      bus.publish({
        type: "scan.completed",
        sourceId: source.id,
        sourceName: source.name,
        scoreValue: result.score.value,
        findingCount: result.findings.length,
        at: result.finishedAt.toISOString(),
      });
    }
    return result;
  } catch (err) {
    if (options.emitEvents) {
      bus.publish({
        type: "scan.failed",
        sourceId: source.id,
        error: (err as Error).message,
        at: new Date().toISOString(),
      });
    }
    throw err;
  }
}
