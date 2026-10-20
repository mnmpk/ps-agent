import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { HealthService } from "../../service/healthService.js";
import type { CollectedFacts } from "../../core/types.js";

/**
 * Read-only tools the chat agent can call. Every tool is grounded in persisted
 * scan data or triggers a (read-only) scan. The one "action" tool,
 * suggestRemediation, only DRAFTS commands — it never executes anything.
 *
 * All tools return compact JSON strings so a small local model can consume them.
 */
export function buildHealthTools(service: HealthService) {
  const listFleet = tool(
    async () => {
      const fleet = await service.fleetOverview();
      return JSON.stringify(
        fleet.map((f) => ({
          sourceId: f.source.id,
          name: f.source.name,
          deployment: f.source.deployment,
          score: f.score?.value,
          counts: f.score?.counts,
          lastScannedAt: f.lastScannedAt,
        })),
      );
    },
    {
      name: "list_fleet",
      description:
        "List all registered MongoDB deployments with their latest health score and finding counts. Use this first to discover sourceIds and names.",
      schema: z.object({}),
    },
  );

  const queryFindings = tool(
    async ({ sourceId, severity }) => {
      const risks = await service.riskInbox();
      let items = risks;
      if (sourceId) items = items.filter((r) => r.sourceId === sourceId);
      if (severity) items = items.filter((r) => r.severity === severity);
      return JSON.stringify(
        items.map((r) => ({
          sourceName: r.sourceName,
          sourceId: r.sourceId,
          severity: r.severity,
          category: r.category,
          checkId: r.checkId,
          title: r.title,
          detail: r.detail,
          // Evidence holds the specifics (e.g. which namespaces/indexes), which
          // the model needs to answer "which collection has redundant indexes?".
          evidence: r.evidence,
          remediation: r.remediation,
        })),
      );
    },
    {
      name: "query_findings",
      description:
        "Query current health findings across the fleet. Optionally filter by sourceId and/or severity (ok|info|warning|critical). Returns each finding's checkId, title, detail, and evidence — evidence contains the specifics such as the affected namespaces, index names, or metric values.",
      schema: z.object({
        sourceId: z.string().optional().describe("Limit to one deployment."),
        severity: z
          .enum(["ok", "info", "warning", "critical"])
          .optional()
          .describe("Limit to a severity level."),
      }),
    },
  );

  const getLatestScan = tool(
    async ({ sourceId }) => {
      const metas = await service.listScans(sourceId);
      const latest = metas[0];
      if (!latest) return JSON.stringify({ error: "No scans for this source yet." });
      const scan = await service.getScan(latest.id);
      if (!scan) return JSON.stringify({ error: "Scan not found." });
      return JSON.stringify(summarizeScan(scan.facts, scan.score.value, scan.findings.length));
    },
    {
      name: "get_latest_scan",
      description:
        "Get the latest scan summary for a deployment: topology, score, key metrics, and finding count. Use the sourceId from list_fleet.",
      schema: z.object({ sourceId: z.string().describe("The deployment's sourceId.") }),
    },
  );

  const getMetrics = tool(
    async ({ sourceId }) => {
      const metas = await service.listScans(sourceId);
      const latest = metas[0];
      if (!latest) return JSON.stringify({ error: "No scans yet." });
      const scan = await service.getScan(latest.id);
      if (!scan) return JSON.stringify({ error: "Scan not found." });
      return JSON.stringify(extractMetrics(scan.facts));
    },
    {
      name: "get_metrics",
      description:
        "Get the key resource/query metrics from the latest scan of a deployment (connections, CPU, tickets, cache, query targeting). Use to answer 'why is X amber?' or capacity questions.",
      schema: z.object({ sourceId: z.string().describe("The deployment's sourceId.") }),
    },
  );

  const runScanNow = tool(
    async ({ sourceId }) => {
      const scan = await service.scanSource(sourceId, false);
      return JSON.stringify({
        score: scan.score.value,
        counts: scan.score.counts,
        findings: scan.findings.map((f) => ({ severity: f.severity, checkId: f.checkId, title: f.title })),
      });
    },
    {
      name: "run_scan_now",
      description:
        "Run a fresh read-only health scan for a deployment right now and return the new findings. Use when the user asks to re-scan or wants current state.",
      schema: z.object({ sourceId: z.string().describe("The deployment's sourceId.") }),
    },
  );

  const suggestRemediation = tool(
    async ({ sourceId, checkId }) => {
      const metas = await service.listScans(sourceId);
      const latest = metas[0];
      const scan = latest ? await service.getScan(latest.id) : null;
      const finding = scan?.findings.find((f) => f.checkId === checkId);
      if (!finding) {
        return JSON.stringify({ error: `No finding ${checkId} on this source.` });
      }
      // DRAFT ONLY. This never executes anything; it returns guidance + caveats.
      return JSON.stringify({
        checkId,
        title: finding.title,
        severity: finding.severity,
        guidance: finding.remediation ?? "No automated remediation available; investigate manually.",
        docs: finding.docs,
        caveat:
          "This is advisory only. ps-agent does not modify your cluster. Validate against your workload and change-management process before acting.",
      });
    },
    {
      name: "suggest_remediation",
      description:
        "Draft (advisory only) remediation guidance for a specific finding (by sourceId + checkId). Never executes changes; returns steps and caveats.",
      schema: z.object({
        sourceId: z.string(),
        checkId: z.string().describe("The checkId of the finding to remediate."),
      }),
    },
  );

  const getCapacity = tool(
    async ({ sourceId }) => {
      const r = await service.getCapacityReport(sourceId);
      // Compact, model-friendly shape with the key numbers.
      return JSON.stringify({
        hasLimits: r.hasLimits,
        windowDays: r.windowDays,
        growth: r.growth.map((g) => ({
          metric: g.metric,
          perWeekBytes: Math.round(g.perWeek),
          perWeekPct: g.perWeekPct != null ? Number(g.perWeekPct.toFixed(1)) : undefined,
          daysUntilFull: g.daysUntilFull != null ? Math.round(g.daysUntilFull) : undefined,
          projectedFullDate: g.projectedFullDate,
          confidenceR2: Number(g.trend.r2.toFixed(2)),
        })),
        utilization: r.utilization.map((u) => ({
          resource: u.label,
          currentPct: u.current != null ? Number((u.current * 100).toFixed(1)) : undefined,
          p95Pct: u.p95 != null ? Number((u.p95 * 100).toFixed(1)) : undefined,
          unbounded: u.unbounded,
        })),
        scale: r.scale,
        bottlenecks: r.bottlenecks,
        notes: r.notes,
      });
    },
    {
      name: "get_capacity",
      description:
        "Get the capacity report for a deployment: data-growth rate and days-until-disk-full, resource utilization (current + p95) vs limits, a scale recommendation (up/out/down + factor + target tier), and ranked bottlenecks (resource + slow-query). Use for 'how fast is data growing', 'when do I need to scale', 'is there cost-optimization room', and 'what's the bottleneck'. Atlas sources only.",
      schema: z.object({ sourceId: z.string().describe("The deployment's sourceId.") }),
    },
  );

  const getBottlenecks = tool(
    async ({ sourceId }) => {
      const r = await service.getCapacityReport(sourceId);
      return JSON.stringify(r.bottlenecks);
    },
    {
      name: "get_bottlenecks",
      description:
        "Get the ranked performance bottlenecks for a deployment (resource + slow-query signals, each with evidence incl. affected namespace, COLLSCAN count, scanned-per-returned). Use for 'where/what is the bottleneck'.",
      schema: z.object({ sourceId: z.string().describe("The deployment's sourceId.") }),
    },
  );

  const getMetricTrend = tool(
    async ({ sourceId, metric, days }) => {
      const since = new Date(Date.now() - (days ?? 14) * 86_400_000);
      const points = await service.getMetricSeries(sourceId, metric, { since });
      if (points.length === 0) return JSON.stringify({ metric, points: 0, note: "no data" });
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const vals = points.map((p) => p.value);
      return JSON.stringify({
        metric,
        points: points.length,
        from: first.ts,
        to: last.ts,
        firstValue: first.value,
        latestValue: last.value,
        min: Math.min(...vals),
        max: Math.max(...vals),
      });
    },
    {
      name: "get_metric_trend",
      description:
        "Get a stored metric time-series summary for a deployment over the last N days (first/latest/min/max). Metrics include DISK_PARTITION_SPACE_USED, CONNECTIONS, SYSTEM_NORMALIZED_CPU_USER, CACHE_USED_BYTES, etc. Use get_capacity first for the high-level answer.",
      schema: z.object({
        sourceId: z.string(),
        metric: z.string().describe("Metric name, e.g. DISK_PARTITION_SPACE_USED."),
        days: z.number().optional().describe("Lookback window in days (default 14)."),
      }),
    },
  );

  return [
    listFleet,
    queryFindings,
    getLatestScan,
    getMetrics,
    runScanNow,
    suggestRemediation,
    getCapacity,
    getBottlenecks,
    getMetricTrend,
  ];
}

// --- helpers ---------------------------------------------------------------

function summarizeScan(facts: CollectedFacts, score: number, findingCount: number) {
  return {
    deployment: facts.sourceName,
    topology: facts.topology,
    score,
    findingCount,
    host: facts.serverStatus?.host ?? (facts.atlas ? `Atlas:${facts.atlas.projectId}` : "unknown"),
    collectedAt: facts.collectedAt,
  };
}

function extractMetrics(facts: CollectedFacts): Record<string, unknown> {
  // Direct source metrics
  if (facts.serverStatus) {
    const s = facts.serverStatus;
    return {
      kind: "direct",
      connections: s.connections,
      tickets: s.tickets,
      wiredTigerCacheDirtyPct:
        s.wiredTigerCache && s.wiredTigerCache.maxBytes
          ? (s.wiredTigerCache.dirtyBytes / s.wiredTigerCache.maxBytes) * 100
          : undefined,
      globalLockQueue: s.globalLockQueue,
      opcounters: s.opcounters,
    };
  }
  // Atlas metrics
  if (facts.atlas) {
    return {
      kind: "atlas",
      processes: facts.atlas.processes.map((p) => ({
        host: p.hostname,
        role: p.typeName,
        metrics: Object.fromEntries(
          p.measurements.map((m) => [m.name, { latest: m.latest, avg: m.average, max: m.max }]),
        ),
      })),
    };
  }
  return { kind: "unknown" };
}
