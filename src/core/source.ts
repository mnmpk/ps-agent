import { z } from "zod";

/**
 * How a deployment is hosted. This is the ONLY hard classification; it decides
 * which inputs make sense (Atlas has no FTDC/getMongoData/mdiag; on-prem has no
 * Atlas Admin API). Everything else — which health checks, metrics, and analyses
 * can run — is derived from the *available inputs* (see capabilitiesOf), not from
 * a single collection-method enum.
 *
 *   atlas   — MongoDB Atlas (cloud). Inputs: connection string, MCP, Atlas Admin
 *             API, mongod.log.
 *   on-prem — self-managed (Enterprise/Community). Inputs: connection string, MCP,
 *             Ops Manager Admin API, FTDC, getMongoData, mdiag, mongod.log.
 */
export const Deployment = z.enum(["atlas", "on-prem"]);
export type Deployment = z.infer<typeof Deployment>;

export const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Hosting classification. */
  deployment: Deployment,
  // --- Live connectivity (either type) ---
  /** Direct driver connection string (stored encrypted at rest). */
  connectionString: z.string().optional(),
  /** MongoDB MCP server connection. */
  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]),
      command: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  // --- Atlas-only admin API ---
  atlas: z
    .object({
      projectId: z.string(),
      publicKey: z.string(),
      privateKey: z.string(),
      clusterName: z.string().optional(),
    })
    .optional(),
  // --- On-prem-only admin API (Ops Manager) ---
  // Same metrics/history path as Atlas, different base URL + API path, no tier spec.
  opsManager: z
    .object({
      baseUrl: z.string(), // e.g. https://opsmgr.example.com:8080
      projectId: z.string(),
      publicKey: z.string(),
      privateKey: z.string(),
    })
    .optional(),
  tags: z.array(z.string()).optional(),
  /**
   * FTDC ingest provenance: what diagnostic data was imported, from where, and
   * the time range it covered — WITHOUT storing the raw bytes. Lets operators see
   * what history has been ingested and re-import gaps. Appended on each import.
   */
  ftdcProvenance: z
    .object({
      /** Per-ingest events, most-recent last (capped to a recent window). */
      imports: z
        .array(
          z.object({
            at: z.string(), // ISO timestamp of the import
            input: z.string().optional(), // the path(s) the operator pointed at
            filesProcessed: z.number().int().nonnegative(),
            nodes: z.array(z.string()), // host:port seen in this batch
            metricPointsAdded: z.number().int().nonnegative(),
            /** Data time range covered by this batch (ISO), if known. */
            coveredFrom: z.string().optional(),
            coveredTo: z.string().optional(),
          }),
        )
        .default([]),
      /** Per-node coverage roll-up across all imports (earliest→latest, ISO). */
      nodes: z
        .record(
          z.string(), // host:port
          z.object({
            from: z.string(),
            to: z.string(),
            lastImportedAt: z.string(),
          }),
        )
        .default({}),
    })
    .optional(),
  /**
   * Aggregated slow-query signals distilled from imported mongod.log file(s),
   * per namespace. Stored (compact, redaction-safe — no query values) so the
   * offline capacity report can surface query bottlenecks the same way Atlas/
   * OpsManager sources do via the Performance Advisor. Replaced on each import.
   */
  logQuerySignals: z
    .array(
      z.object({
        namespace: z.string(),
        slowCount: z.number().int().nonnegative(),
        collscanCount: z.number().int().nonnegative(),
        worstScannedPerReturned: z.number().nonnegative(),
        maxDurationMs: z.number().nonnegative(),
        example: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Lightweight attachment markers for the offline file imports whose signal
   * otherwise lives only inside the latest scan's facts. Lets the data-availability
   * view (and capabilitiesOf) know what's attached without loading a scan. Each
   * records when it was last imported. (FTDC has its own richer `ftdcProvenance`;
   * mongod.log also leaves `logQuerySignals`.)
   */
  attachments: z
    .object({
      getMongoData: z.object({ at: z.string() }).optional(),
      mdiag: z.object({ at: z.string() }).optional(),
      mongodLog: z.object({ at: z.string() }).optional(),
    })
    .optional(),
  /** Scheduling + threshold overrides for this deployment. */
  schedule: z
    .object({
      /** Automatic scan cadence in seconds. Omitted/0 = manual only. */
      intervalSeconds: z.number().int().positive().optional(),
      enabled: z.boolean().default(true),
    })
    .optional(),
  /** Partial overrides merged onto DEFAULT_THRESHOLDS for this source. */
  thresholdOverrides: z.record(z.string(), z.number()).optional(),
});

export type Source = z.infer<typeof SourceSchema>;
