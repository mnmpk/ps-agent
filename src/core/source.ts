import { z } from "zod";

/**
 * A registered deployment to monitor. v1 of the CLI supports the "direct"
 * kind (connection string). Atlas/MCP kinds are reserved for later phases
 * but defined here so the schema is stable.
 */
export const SourceKind = z.enum(["direct", "atlas", "mcp", "opsmanager", "offline"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: SourceKind,
  // direct
  connectionString: z.string().optional(),
  // atlas (reserved)
  atlas: z
    .object({
      projectId: z.string(),
      publicKey: z.string(),
      privateKey: z.string(),
      clusterName: z.string().optional(),
    })
    .optional(),
  // mcp (reserved)
  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]),
      command: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  // Ops Manager (self-managed) — same metrics/history path as Atlas, different
  // base URL + API path, and no cluster tier spec.
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
