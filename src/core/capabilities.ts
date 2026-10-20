import type { Source, Deployment } from "./source.js";
import type { CollectedFacts } from "./types.js";

/**
 * Central availability / capability model for a deployment.
 *
 * `kind` used to conflate hosting classification, collection method, and
 * liveness. Instead we classify the deployment (atlas | on-prem) and derive what
 * can be scanned/shown from the *available inputs* — connectivity (connection
 * string, MCP, Atlas/Ops Manager Admin API) plus imported diagnostics (FTDC,
 * getMongoData, mdiag, mongod.log). This module is the single source of truth, so
 * both runtime gating and the dashboard's "data availability + consequences"
 * panel agree.
 */

/** The distinct kinds of input a source can have. */
export type InputKind =
  | "connectionString"
  | "mcp"
  | "atlasApi"
  | "opsManagerApi"
  | "ftdc"
  | "getMongoData"
  | "mdiag"
  | "mongodLog";

/** Which inputs are valid for each deployment type (for the form + validation). */
export const ALLOWED_INPUTS: Record<Deployment, InputKind[]> = {
  atlas: ["connectionString", "mcp", "atlasApi", "mongodLog"],
  "on-prem": [
    "connectionString",
    "mcp",
    "opsManagerApi",
    "ftdc",
    "getMongoData",
    "mdiag",
    "mongodLog",
  ],
};

/** The capabilities a source can have (what scans/analyses/metrics can run). */
export interface Capabilities {
  /** A live scan can connect and collect facts (needs connection string or MCP). */
  liveScan: boolean;
  /** Deep driver health checks (replication, tickets, cache, index usage). */
  deepHealthChecks: boolean;
  /** Data-layer storage facts (disk/db sizes) — driver or MCP db-stats. */
  storage: boolean;
  /** Historical metric trends & capacity/growth analysis (needs series). */
  capacityTrends: boolean;
  /** Cluster tier limits for utilization % (Atlas spec or hostInfo RAM/cores). */
  utilizationLimits: boolean;
  /** Per-namespace slow-query bottleneck analysis (PA or mongod.log). */
  slowQueryAnalysis: boolean;
  /** Expert risk-register assessment (needs any scan with facts). */
  riskRegister: boolean;
  /** OS/kernel risk evaluation (needs mdiag on Linux). */
  osRiskChecks: boolean;
  /** mongod.log operational signals (errors, elections, restarts, …). */
  logSignals: boolean;
}

/** One available input, for display. */
export interface AvailableInput {
  kind: InputKind;
  label: string;
  /** When it was attached/last imported, if known (ISO). */
  at?: string;
}

/** One missing input + the capability consequence of not having it. */
export interface MissingInput {
  kind: InputKind;
  label: string;
  /** What you lose by not having this. */
  consequence: string;
  /** How to supplement: "import" (upload a file) or "connect" (add creds). */
  supplement: "import" | "connect";
}

export interface Availability {
  deployment: Deployment;
  capabilities: Capabilities;
  available: AvailableInput[];
  missing: MissingInput[];
}

const INPUT_LABELS: Record<InputKind, string> = {
  connectionString: "Connection string",
  mcp: "MCP connection",
  atlasApi: "Atlas Admin API",
  opsManagerApi: "Ops Manager Admin API",
  ftdc: "FTDC diagnostic data",
  getMongoData: "getMongoData output",
  mdiag: "mdiag output",
  mongodLog: "mongod.log",
};

/** What capability each input unlocks (shown as the consequence of missing it). */
const INPUT_CONSEQUENCE: Record<InputKind, string> = {
  connectionString:
    "No live health scan via the driver — deep checks (replication, tickets, cache, index usage) are unavailable.",
  mcp: "No MCP-based data-layer facts (disk/storage via db-stats) when no connection string is set.",
  atlasApi:
    "No Atlas metric history, cluster tier limits, open alerts, or Performance Advisor slow queries — capacity trends and slow-query analysis are limited.",
  opsManagerApi:
    "No Ops Manager metric history or slow-query logs — capacity trends and slow-query analysis are limited.",
  ftdc: "No offline capacity trends (CPU/memory/disk/IOPS growth, days-until-full).",
  getMongoData:
    "No offline config/status/index/storage snapshot — health & risk assessment are limited without a live connection.",
  mdiag: "No OS/kernel risk checks (swappiness, THP, ulimits, SELinux, NUMA, …).",
  mongodLog:
    "No log signals (errors, elections, restarts, storage warnings, assertions) and no offline slow-query analysis.",
};

/** Whether the source has a given input available. */
function hasInput(source: Source, facts: CollectedFacts | null): Record<InputKind, { has: boolean; at?: string }> {
  return {
    connectionString: { has: !!source.connectionString },
    mcp: { has: !!source.mcp },
    atlasApi: { has: !!source.atlas },
    opsManagerApi: { has: !!source.opsManager },
    ftdc: {
      has: !!source.ftdcProvenance && (source.ftdcProvenance.imports?.length ?? 0) > 0,
      at: source.ftdcProvenance?.imports?.at(-1)?.at,
    },
    getMongoData: { has: !!source.attachments?.getMongoData, at: source.attachments?.getMongoData?.at },
    mdiag: {
      has: !!source.attachments?.mdiag || !!facts?.os,
      at: source.attachments?.mdiag?.at,
    },
    mongodLog: {
      has: !!source.attachments?.mongodLog || !!facts?.log || !!source.logQuerySignals?.length,
      at: source.attachments?.mongodLog?.at,
    },
  };
}

/**
 * Derive the full availability picture for a source.
 *
 * @param source     the (full, non-redacted) source
 * @param facts      the latest scan's facts, if any (for mdiag/log/serverStatus flags)
 * @param hasSeries  whether stored metric series exist (FTDC or Atlas/OM history)
 */
export function availabilityOf(
  source: Source,
  facts: CollectedFacts | null,
  hasSeries: boolean,
): Availability {
  const inputs = hasInput(source, facts);
  const deployment = source.deployment;

  const liveScan = inputs.connectionString.has || inputs.mcp.has;
  const deepHealthChecks = inputs.connectionString.has || !!facts?.serverStatus;
  const storage = inputs.connectionString.has || inputs.mcp.has || !!facts?.storage;
  const historyApi = inputs.atlasApi.has || inputs.opsManagerApi.has;
  const capacityTrends = hasSeries || historyApi || inputs.ftdc.has;
  const utilizationLimits = inputs.atlasApi.has || !!facts?.hostInfo || !!facts?.atlas;
  const slowQueryAnalysis = historyApi || inputs.mongodLog.has;
  const riskRegister = !!facts; // any scan with facts
  const osRiskChecks = inputs.mdiag.has;
  const logSignals = inputs.mongodLog.has;

  const capabilities: Capabilities = {
    liveScan,
    deepHealthChecks,
    storage,
    capacityTrends,
    utilizationLimits,
    slowQueryAnalysis,
    riskRegister,
    osRiskChecks,
    logSignals,
  };

  const allowed = ALLOWED_INPUTS[deployment];
  const available: AvailableInput[] = [];
  const missing: MissingInput[] = [];
  for (const kind of allowed) {
    const state = inputs[kind];
    if (state.has) {
      available.push({ kind, label: INPUT_LABELS[kind], at: state.at });
    } else {
      missing.push({
        kind,
        label: INPUT_LABELS[kind],
        consequence: INPUT_CONSEQUENCE[kind],
        supplement: isConnectivity(kind) ? "connect" : "import",
      });
    }
  }

  return { deployment, capabilities, available, missing };
}

/** Connectivity inputs are "connect"; file diagnostics are "import". */
export function isConnectivity(kind: InputKind): boolean {
  return (
    kind === "connectionString" ||
    kind === "mcp" ||
    kind === "atlasApi" ||
    kind === "opsManagerApi"
  );
}
