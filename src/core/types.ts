/**
 * Core shared types for the health agent.
 *
 * Design principle: Collectors produce raw, typed *facts* (no judgement).
 * The rule engine turns facts into *findings* (deterministic judgements).
 * The LLM layer only ever reasons over findings + facts; it never measures.
 */

export type Severity = "ok" | "info" | "warning" | "critical";

/** Severity ordering for sorting / comparison (higher = worse). */
export const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

export type Category =
  | "availability"
  | "replication"
  | "resource"
  | "query"
  | "configuration";

// ---------------------------------------------------------------------------
// Facts — the raw material gathered by collectors
// ---------------------------------------------------------------------------

export interface ReplMember {
  _id: number;
  name: string;
  /** 1 = up, 0 = down (from replSetGetStatus). */
  health: 0 | 1;
  /** Numeric replica set state code. */
  state: number;
  stateStr: string;
  uptimeSec: number;
  /** Optime wall-clock date for this member (used to compute lag). */
  optimeDate?: Date;
  pingMs?: number;
  /** True for the node we are currently connected to. */
  self: boolean;
  /** Voting member (votes > 0). From replica-set config. */
  votes: number;
  /** Election priority. From replica-set config. */
  priority: number;
  /** Hidden member (not advertised to clients). From replica-set config. */
  hidden?: boolean;
  /** Arbiter (votes but holds no data). From replica-set config. */
  arbiterOnly?: boolean;
}

export interface ReplSetStatus {
  set: string;
  myStateStr: string;
  members: ReplMember[];
  /** Seconds of oplog retained (first→last entry), if known. */
  oplogWindowHours?: number;
}

export interface ConnectionStats {
  current: number;
  available: number;
  totalCreated: number;
}

export interface WiredTigerCache {
  bytesInCache: number;
  maxBytes: number;
  dirtyBytes: number;
  /** pages evicted because the cache was over the eviction trigger. */
  pagesEvictedForcibly?: number;
}

export interface OpCounters {
  insert: number;
  query: number;
  update: number;
  delete: number;
  getmore: number;
  command: number;
}

export interface ServerStatus {
  host: string;
  version: string;
  processName: string;
  uptimeSec: number;
  connections: ConnectionStats;
  opcounters: OpCounters;
  wiredTigerCache?: WiredTigerCache;
  /** Available read/write concurrency tickets (null if not reported). */
  tickets?: {
    readAvailable: number;
    readOut: number;
    writeAvailable: number;
    writeOut: number;
  };
  globalLockQueue?: { total: number; readers: number; writers: number };
  /** Security-related command line options we care about. */
  security?: {
    authEnabled: boolean;
    tlsEnabled: boolean;
  };
}

export interface IndexUsage {
  db: string;
  collection: string;
  name: string;
  /** Number of operations that used this index since server start / stats reset. */
  ops: number;
  keys: Record<string, 1 | -1 | string>;
}

/**
 * OS/kernel tuning facts from an mdiag.sh export (Linux). These are the settings
 * getMongoData can't see; they drive the OS-level risk-register checks.
 */
export interface OsFacts {
  /** vm.swappiness */
  swappiness?: number;
  /** vm.max_map_count */
  maxMapCount?: number;
  /** net.ipv4.tcp_keepalive_time (seconds) */
  tcpKeepaliveTime?: number;
  /** net.core.somaxconn */
  somaxconn?: number;
  /** Transparent HugePages enabled setting (e.g. "always", "never", "madvise"). */
  transparentHugePages?: string;
  /** Transparent HugePages defrag setting. */
  thpDefrag?: string;
  /** Max disk read_ahead_kb seen across devices. */
  readAheadKb?: number;
  /** Soft/open file-descriptor limit (ulimit -n). */
  openFilesLimit?: number;
  /** Max processes limit (ulimit -u). */
  maxProcessesLimit?: number;
  /** SELinux status (e.g. "enforcing", "permissive", "disabled"). */
  selinux?: string;
  /** NUMA present/enabled (from numactl). */
  numa?: boolean;
  /** Disk I/O scheduler(s) seen. */
  ioScheduler?: string;
  /** mdiag reference/ticket + version, for provenance. */
  mdiagVersion?: string;
  mdiagRef?: string;
  /** Hostname the mdiag was collected on (for grouping node-level imports). */
  hostname?: string;
  /** Non-fatal parse notes. */
  warnings?: string[];
}

/**
 * Operational signals distilled from a mongod.log file (structured JSON, 4.4+).
 * Unlike serverStatus (a point-in-time snapshot), these summarize events that
 * happened over the log's time range — errors, elections, restarts, storage
 * warnings, etc. Produced by the offline mongod.log parser; consumed by the
 * `log.*` health checks. Defensive: any field may be absent/zero.
 */
export interface LogFacts {
  /** Count of lines at severity Error ("E") and Fatal ("F"). */
  errorCount: number;
  fatalCount: number;
  /** Count of Warning ("W") lines. */
  warningCount: number;
  /** Total lines parsed (for rates/denominators). */
  totalLines: number;
  /** Process startups seen (each indicates a (re)start of mongod). */
  startupCount: number;
  /** Unclean shutdowns / shutdown-on-signal events. */
  uncleanShutdownCount: number;
  /** Replica-set elections observed (component REPL_ELECTION / election msgs). */
  electionCount: number;
  /** Replica-set state transitions to PRIMARY/SECONDARY/ROLLBACK, etc. */
  stateChangeCount: number;
  /** WiredTiger / storage warnings or errors (component STORAGE/WT). */
  storageWarningCount: number;
  /** Assertions / invariant failures / fassert. */
  assertionCount: number;
  /** Connections accepted (churn signal). */
  connectionsAccepted: number;
  /** Connections ended. */
  connectionsEnded: number;
  /** Slow-query (OP) lines seen (msg "Slow query"). */
  slowQueryCount: number;
  /** Earliest / latest log timestamp observed (ISO), for the covered window. */
  firstTs?: string;
  lastTs?: string;
  /** Hostname, if a startup line reported it (for grouping node-level imports). */
  hostname?: string;
  /** mongod version from a startup line, when present. */
  mongoVersion?: string;
  /** Most frequent distinct error/fatal messages (top few), for findings. */
  topErrors?: Array<{ msg: string; count: number; sample?: string }>;
  /** Non-fatal parse notes (e.g. lines skipped, legacy format detected). */
  warnings?: string[];
}

/** Host hardware facts (from db.hostInfo()); the limits for offline/direct capacity. */
export interface HostInfo {
  hostname?: string;
  cpuCores?: number;
  memSizeMB?: number;
  os?: string;
  numaEnabled?: boolean;
  /** hostInfo.extra (Linux: readahead etc.; otherwise misc). */
  extra?: Record<string, unknown>;
}

export interface Topology {
  type: "standalone" | "replicaSet" | "sharded";
  mongoVersion: string;
  /** For replica sets: set name. */
  setName?: string;
  nodeCount: number;
}

// ---------------------------------------------------------------------------
// Atlas facts — gathered from the Atlas Admin API (metric-based)
// ---------------------------------------------------------------------------

/** A single named time-series measurement for an Atlas process. */
export interface AtlasMeasurement {
  name: string; // e.g. "SYSTEM_CPU_USER", "CONNECTIONS", "DISK_PARTITION_SPACE_FREE"
  units: string;
  /** Most recent non-null data point value, if any. */
  latest?: number;
  /** Simple average of non-null data points over the window. */
  average?: number;
  /** Maximum non-null data point over the window. */
  max?: number;
  /** Number of non-null data points. */
  dataPointCount: number;
}

export interface AtlasProcess {
  id: string; // host:port, used as processId
  hostname: string;
  port: number;
  typeName: string; // REPLICA_PRIMARY, REPLICA_SECONDARY, SHARD_MONGOS, etc.
  version: string;
  replicaSetName?: string;
  measurements: AtlasMeasurement[];
}

export interface AtlasAlert {
  id: string;
  eventTypeName: string;
  status: string; // OPEN, TRACKING, CLOSED
  created?: Date;
  acknowledgedUntil?: Date;
}

export interface AtlasSuggestedIndex {
  namespace: string;
  weight: number; // estimated impact
  keys: Array<Record<string, number>>;
}

/**
 * Cluster hardware spec + limits (from Atlas GET /clusters/{name}), needed to
 * compute utilization % and scaling recommendations. Fields may be absent for
 * sources where the spec can't be read.
 */
export interface ClusterSpec {
  instanceSize?: string; // "M30", "M40 Low-CPU", …
  diskSizeGB?: number;
  diskIOPS?: number;
  nodeCount?: number;
  /** RAM in GB for the instance size (from the hardcoded tier table). */
  ramGB?: number;
  /** vCPUs for the instance size (tier table), if known. */
  vcpus?: number;
  autoScaling?: {
    computeEnabled?: boolean;
    diskEnabled?: boolean;
    minInstanceSize?: string;
    maxInstanceSize?: string;
  };
  provider?: string; // AWS/GCP/AZURE
  regionName?: string;
}

export interface AtlasFacts {
  projectId: string;
  clusterName?: string;
  processes: AtlasProcess[];
  openAlerts: AtlasAlert[];
  suggestedIndexes: AtlasSuggestedIndex[];
  /** Cluster hardware spec + limits (when readable). */
  clusterSpec?: ClusterSpec;
}

// ---------------------------------------------------------------------------
// Metric time series — historical data for capacity/trend/bottleneck analysis
// ---------------------------------------------------------------------------

/** One data point in a metric series. */
export interface MetricPoint {
  ts: Date;
  value: number;
}

/**
 * A named time series for one source (and optionally one process). Stored in
 * the MetricSeriesStore; backfilled from the Atlas/OM API and appended each scan.
 */
export interface MetricSeries {
  sourceId: string;
  /** Process/host this series belongs to (omitted = cluster/source level). */
  processId?: string;
  metric: string; // e.g. "SYSTEM_NORMALIZED_CPU_USER", "DISK_PARTITION_SPACE_USED"
  units: string;
  points: MetricPoint[];
}

/** Data-layer storage facts (available from MCP db-stats or the driver). */
export interface StorageFacts {
  /** Filesystem usage for the data partition, if reported. */
  fsUsedBytes?: number;
  fsTotalBytes?: number;
  /** Aggregate logical data size across databases. */
  dataSizeBytes?: number;
  indexSizeBytes?: number;
  /** Per-database roll-up for context. */
  databases?: Array<{ name: string; dataSize: number; indexSize: number; collections: number }>;
}

/** Everything a single scan collected for one source. */
export interface CollectedFacts {
  sourceId: string;
  sourceName: string;
  collectedAt: Date;
  topology: Topology;
  /** Present for direct/driver-based sources. */
  serverStatus?: ServerStatus;
  replSetStatus?: ReplSetStatus;
  indexUsage?: IndexUsage[];
  /** Present for Atlas sources. */
  atlas?: AtlasFacts;
  /** Data-layer storage facts (MCP or driver). */
  storage?: StorageFacts;
  /** Host hardware (RAM/cores) — from hostInfo (offline / enhanced direct). */
  hostInfo?: HostInfo;
  /** Selected server parameters (getParameter '*') for config-risk evaluation. */
  serverParameters?: Record<string, unknown>;
  /** OS/kernel tuning facts from an imported mdiag.sh export (Linux). */
  os?: OsFacts;
  /** Operational signals from an imported mongod.log file (structured JSON). */
  log?: LogFacts;
  /** How facts were gathered (for UI + transparency). */
  collectionMethod?: "direct" | "atlas" | "mcp" | "mcp+direct" | "offline";
  /** Non-fatal collection problems (e.g. missing privilege for a command). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Findings — deterministic judgements produced by the rule engine
// ---------------------------------------------------------------------------

export interface Finding {
  checkId: string;
  category: Category;
  severity: Severity;
  title: string;
  /** Human-readable explanation grounded in evidence. */
  detail: string;
  /** The exact numbers that triggered this finding (for UI + LLM citation). */
  evidence: Record<string, unknown>;
  /** Optional remediation guidance / doc link. */
  remediation?: string;
  docs?: string;
}

export interface HealthScore {
  /** 0 (worst) – 100 (best). */
  value: number;
  counts: Record<Severity, number>;
}

/**
 * LLM-produced narration layered on top of deterministic findings.
 * The model may only reference existing findings (by checkId); it cannot
 * invent new ones. Produced by the correlate_and_rank graph node.
 */
export interface HealthAnalysis {
  /** One-paragraph executive summary for the dashboard. */
  summary: string;
  /** Ordered top risks, each tied to one or more existing finding checkIds. */
  topRisks: Array<{
    title: string;
    severity: Severity;
    /** checkIds of the findings this risk correlates. */
    relatedCheckIds: string[];
    rationale: string;
  }>;
  /** Suggested next actions, highest-impact first. */
  recommendations: string[];
  /** Which LLM produced this (provider/model), or "none" if skipped. */
  generatedBy: string;
}

export interface ScanResult {
  sourceId: string;
  sourceName: string;
  startedAt: Date;
  finishedAt: Date;
  facts: CollectedFacts;
  findings: Finding[];
  score: HealthScore;
  /** Present only when LLM summarization ran. */
  analysis?: HealthAnalysis;
}
