import { z } from "zod";

/**
 * A registered deployment to monitor. v1 of the CLI supports the "direct"
 * kind (connection string). Atlas/MCP kinds are reserved for later phases
 * but defined here so the schema is stable.
 */
export const SourceKind = z.enum(["direct", "atlas", "mcp", "opsmanager"]);
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
