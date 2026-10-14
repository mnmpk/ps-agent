import { Annotation } from "@langchain/langgraph";
import type {
  CollectedFacts,
  Finding,
  HealthAnalysis,
  HealthScore,
} from "../core/types.js";
import type { Source } from "../core/source.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../checks/index.js";

/**
 * Shared state for the health-scan graph. Each node reads/writes a subset.
 * Reducers here are last-write-wins (default) since the scan is sequential.
 */
export const HealthScanState = Annotation.Root({
  source: Annotation<Source>(),
  thresholds: Annotation<Thresholds>({
    reducer: (_prev, next) => next,
    default: () => DEFAULT_THRESHOLDS,
  }),
  facts: Annotation<CollectedFacts | undefined>(),
  findings: Annotation<Finding[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  score: Annotation<HealthScore | undefined>(),
  analysis: Annotation<HealthAnalysis | undefined>(),
  /** Set when LLM summarization should be attempted. */
  summarize: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

export type HealthScanStateType = typeof HealthScanState.State;
