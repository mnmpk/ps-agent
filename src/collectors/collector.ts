import type { CollectedFacts } from "../core/types.js";

/**
 * A Collector gathers raw facts from one source. Implementations:
 *  - DirectCollector  (mongodb driver, self-managed or any connection string)
 *  - AtlasCollector   (Atlas Admin API)      — later phase
 *  - McpCollector     (MongoDB MCP server)    — later phase
 *
 * Collectors MUST NOT make health judgements. They only measure.
 */
export interface Collector {
  collect(): Promise<CollectedFacts>;
  close(): Promise<void>;
}
