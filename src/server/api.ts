import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HealthService } from "../service/healthService.js";
import { renderDashboard } from "./dashboard.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { bus, type AgentEvent } from "../events/bus.js";
import { closeMongoClient } from "../store/mongo/client.js";
import { isMultipart, parseMultipart } from "./multipart.js";

/**
 * Minimal HTTP API + dashboard for the health agent.
 *
 * Uses Node's built-in http server to stay dependency-light for this phase.
 * The design (§10) names Fastify; because all logic lives in HealthService,
 * swapping the transport later is mechanical.
 *
 * Routes:
 *   GET  /                          dashboard SPA
 *   GET  /api/fleet                 latest scan per source (overview)
 *   GET  /api/risks                 cross-fleet findings (risk inbox)
 *   GET  /api/sources               list registered sources (redacted)
 *   POST /api/sources               register { name, connectionString }
 *   DELETE /api/sources/:id         remove a source
 *   POST /api/sources/:id/scan      run a scan (?summarize=1)
 *   GET  /api/scans?sourceId=:id    list scan snapshots
 *   GET  /api/scans/:scanId         full scan result (facts+findings+analysis)
 */
export interface ApiServerOptions {
  port?: number;
  host?: string;
  service?: HealthService;
  /** Start the background scheduler (default true). */
  schedule?: boolean;
}

export function createApiServer(options: ApiServerOptions = {}) {
  const service = options.service ?? new HealthService();
  const port = options.port ?? Number(process.env.PS_AGENT_PORT ?? 4000);
  const host = options.host ?? "127.0.0.1";
  const scheduler = new Scheduler(service, {
    summarize: process.env.PS_AGENT_SCHEDULE_SUMMARIZE === "1",
  });

  const server = createServer((req, res) => {
    handle(req, res, service, scheduler).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });

  // Track open sockets so shutdown can force-close long-lived SSE streams,
  // which would otherwise keep `server.close()` (and Ctrl+C) hanging forever.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    backend: service.storeBackend,
    async listen(): Promise<{ port: number; host: string }> {
      if (options.schedule !== false) await scheduler.sync();
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ port, host }));
      });
    },
    async close(): Promise<void> {
      scheduler.stopAll();
      // Stop accepting new connections, then destroy existing ones (SSE).
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        sockets.clear();
      });
      // Never let a slow DB close block process exit.
      await withTimeout(closeMongoClient(), 3000);
    },
  };
}

/** Resolve a promise, but give up after `ms` so shutdown can't hang. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<void> {
  await Promise.race([
    p.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: HealthService,
  scheduler: Scheduler,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Dashboard
  if (method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
    return;
  }

  // --- Risk catalog management ---
  if (method === "GET" && path === "/api/catalog") {
    return sendJson(res, 200, await service.listCatalog());
  }
  if (method === "GET" && path === "/api/catalog/export") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="risks-catalog.json"',
    });
    res.end(JSON.stringify(await service.exportCatalog(), null, 2));
    return;
  }
  if (method === "POST" && path === "/api/catalog") {
    const body = await readJsonBody(req);
    if (!body?.name) return sendJson(res, 400, { error: "name is required" });
    return sendJson(res, 201, await service.upsertCatalogEntry(body));
  }
  if (method === "POST" && path === "/api/catalog/import") {
    const raw = await readRawBody(req);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "body must be JSON ({risks:[…]} or an array)" });
    }
    const mode = url.searchParams.get("mode") === "replace" ? "replace" : "merge";
    try {
      const n = await service.importCatalog(data as any, mode);
      return sendJson(res, 200, { imported: n, mode });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }
  const catalogId = path.match(/^\/api\/catalog\/([^/]+)$/);
  if (catalogId && catalogId[1] !== "export" && catalogId[1] !== "import") {
    const id = decodeURIComponent(catalogId[1]!);
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      if (typeof body?.enabled === "boolean") {
        const updated = await service.setCatalogEntryEnabled(id, body.enabled);
        return sendJson(res, updated ? 200 : 404, updated ?? { error: "not found" });
      }
      return sendJson(res, 200, await service.upsertCatalogEntry({ ...body, id }));
    }
    if (method === "DELETE") {
      const ok = await service.deleteCatalogEntry(id);
      return sendJson(res, ok ? 200 : 404, { removed: ok });
    }
  }

  // Live event stream (SSE): scan.started/completed/failed, schedule.changed.
  if (method === "GET" && path === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`: connected\n\n`);
    const unsubscribe = bus.subscribe((ev: AgentEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  // --- API ---------------------------------------------------------------
  if (method === "GET" && path === "/api/fleet") {
    return sendJson(res, 200, await service.fleetOverview());
  }

  if (method === "GET" && path === "/api/risks") {
    return sendJson(res, 200, await service.riskInbox());
  }

  if (method === "GET" && path === "/api/sources") {
    return sendJson(res, 200, await service.listSources());
  }

  // Offline import: raw body = the getMongoData.js log (JSON array).
  // Optional query params: ?name=... &sourceId=... (to update an existing one).
  if (method === "POST" && path === "/api/sources/offline/import") {
    const raw = await readRawBody(req);
    if (!raw) return sendJson(res, 400, { error: "empty body; POST the getMongoData log" });
    try {
      const scan = await service.importGetMongoData(raw, {
        name: url.searchParams.get("name") ?? undefined,
        sourceId: url.searchParams.get("sourceId") ?? undefined,
      });
      return sendJson(res, 200, scan);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // mdiag import: raw body = the mdiag.sh --json export. Standalone
  // (/api/sources/mdiag/import) creates an offline source; the per-source form
  // (/api/sources/:id/mdiag/import) enriches that source with OS facts.
  const mdiagPerSource = path.match(/^\/api\/sources\/([^/]+)\/mdiag\/import$/);
  if (method === "POST" && (path === "/api/sources/mdiag/import" || mdiagPerSource)) {
    const raw = await readRawBody(req);
    if (!raw) return sendJson(res, 400, { error: "empty body; POST the mdiag --json export" });
    const sourceId = mdiagPerSource
      ? decodeURIComponent(mdiagPerSource[1]!)
      : url.searchParams.get("sourceId") ?? undefined;
    try {
      const scan = await service.importMdiag(raw, {
        name: url.searchParams.get("name") ?? undefined,
        sourceId,
      });
      return sendJson(res, 200, scan);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // FTDC import: binary body = one diagnostic.data/metrics.* archive file.
  // Standalone (/api/sources/ftdc/import) creates an offline source from the
  // FTDC snapshot + metrics; the per-source form (/api/sources/:id/ftdc/import)
  // enriches that source and appends its capacity time-series.
  const ftdcPerSource = path.match(/^\/api\/sources\/([^/]+)\/ftdc\/import$/);
  if (method === "POST" && (path === "/api/sources/ftdc/import" || ftdcPerSource)) {
    const buf = await readRawBuffer(req);
    if (!buf.length) return sendJson(res, 400, { error: "empty body; POST a metrics.* FTDC file" });
    const sourceId = ftdcPerSource
      ? decodeURIComponent(ftdcPerSource[1]!)
      : url.searchParams.get("sourceId") ?? undefined;
    try {
      const scan = await service.importFtdc(buf, {
        name: url.searchParams.get("name") ?? undefined,
        sourceId,
        input: url.searchParams.get("filename") ?? "upload",
      });
      return sendJson(res, 200, scan);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // Unified diagnostics import: one multipart/form-data upload carrying ANY mix
  // of getMongoData / mdiag / FTDC files (a whole folder, multiple nodes). Each
  // part is streamed to a temp file; importBundle auto-classifies + ingests into
  // one cluster source, then the temp files are removed.
  const bundlePerSource = path.match(/^\/api\/sources\/([^/]+)\/import$/);
  if (method === "POST" && (path === "/api/sources/import" || bundlePerSource)) {
    if (!isMultipart(req)) {
      return sendJson(res, 400, {
        error: "expected multipart/form-data with one or more 'files' parts",
      });
    }
    const sourceId = bundlePerSource
      ? decodeURIComponent(bundlePerSource[1]!)
      : url.searchParams.get("sourceId") ?? undefined;
    let parsed: Awaited<ReturnType<typeof parseMultipart>> | null = null;
    try {
      parsed = await parseMultipart(req);
      if (parsed.files.length === 0) {
        return sendJson(res, 400, { error: "no files in upload" });
      }
      const name = parsed.fields.name ?? url.searchParams.get("name") ?? undefined;
      const result = await service.importBundle(
        parsed.files.map((f) => ({ filename: f.filename, path: f.path })),
        { name, sourceId },
      );
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    } finally {
      if (parsed) await parsed.cleanup();
    }
  }

  if (method === "POST" && path === "/api/sources") {
    const body = await readJsonBody(req);
    if (!body?.name) {
      return sendJson(res, 400, { error: "name is required" });
    }
    const hasAtlas =
      body.atlas?.projectId && body.atlas?.publicKey && body.atlas?.privateKey;
    const hasMcp = body.mcp?.transport && (body.mcp?.command || body.mcp?.url);
    const hasOm =
      body.opsManager?.baseUrl &&
      body.opsManager?.projectId &&
      body.opsManager?.publicKey &&
      body.opsManager?.privateKey;
    if (!body.connectionString && !hasAtlas && !hasMcp && !hasOm) {
      return sendJson(res, 400, {
        error:
          "provide one of: connectionString, atlas {…}, mcp {…}, or opsManager { baseUrl, projectId, publicKey, privateKey }",
      });
    }
    const source = await service.registerSource({
      name: String(body.name),
      connectionString: body.connectionString ? String(body.connectionString) : undefined,
      atlas: hasAtlas
        ? {
            projectId: String(body.atlas.projectId),
            publicKey: String(body.atlas.publicKey),
            privateKey: String(body.atlas.privateKey),
            clusterName: body.atlas.clusterName ? String(body.atlas.clusterName) : undefined,
          }
        : undefined,
      mcp: hasMcp
        ? {
            transport: body.mcp.transport === "http" ? "http" : "stdio",
            command: body.mcp.command ? String(body.mcp.command) : undefined,
            url: body.mcp.url ? String(body.mcp.url) : undefined,
          }
        : undefined,
      opsManager: hasOm
        ? {
            baseUrl: String(body.opsManager.baseUrl),
            projectId: String(body.opsManager.projectId),
            publicKey: String(body.opsManager.publicKey),
            privateKey: String(body.opsManager.privateKey),
          }
        : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    });
    return sendJson(res, 201, source);
  }

  if (method === "GET" && path === "/api/audit") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    return sendJson(res, 200, await service.auditTail(limit));
  }

  // Update per-source schedule / threshold overrides.
  const sourceConfig = path.match(/^\/api\/sources\/([^/]+)\/config$/);
  if (method === "PATCH" && sourceConfig) {
    const id = decodeURIComponent(sourceConfig[1]!);
    const body = await readJsonBody(req);
    const schedule =
      body?.schedule !== undefined
        ? {
            intervalSeconds: body.schedule?.intervalSeconds
              ? Number(body.schedule.intervalSeconds)
              : undefined,
            enabled: body.schedule?.enabled !== false,
          }
        : undefined;
    const updated = await service.updateSourceConfig(id, {
      schedule,
      thresholdOverrides: body?.thresholdOverrides,
    });
    if (!updated) return sendJson(res, 404, { error: "source not found" });
    await scheduler.sync(); // apply new cadence immediately
    bus.publish({
      type: "schedule.changed",
      sourceId: id,
      intervalSeconds: updated.schedule?.intervalSeconds,
      enabled: updated.schedule?.enabled ?? true,
      at: new Date().toISOString(),
    });
    return sendJson(res, 200, updated);
  }

  const sourceScan = path.match(/^\/api\/sources\/([^/]+)\/scan$/);
  if (method === "POST" && sourceScan) {
    const id = decodeURIComponent(sourceScan[1]!);
    const summarize = url.searchParams.get("summarize") === "1";
    try {
      const result = await service.scanSource(id, summarize, { emitEvents: true });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // Capacity report: growth, utilization, scale recommendation, bottlenecks.
  const sourceCapacity = path.match(/^\/api\/sources\/([^/]+)\/capacity$/);
  if (method === "GET" && sourceCapacity) {
    const id = decodeURIComponent(sourceCapacity[1]!);
    try {
      return sendJson(res, 200, await service.getCapacityReport(id));
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // Risk register assessment (expert catalog cross-referenced vs this cluster).
  const sourceRisks = path.match(/^\/api\/sources\/([^/]+)\/risks$/);
  if (method === "GET" && sourceRisks) {
    const id = decodeURIComponent(sourceRisks[1]!);
    try {
      return sendJson(res, 200, await service.getRiskReport(id));
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const sourceId = path.match(/^\/api\/sources\/([^/]+)$/);
  if (method === "DELETE" && sourceId) {
    const ok = await service.removeSource(decodeURIComponent(sourceId[1]!));
    return sendJson(res, ok ? 200 : 404, { removed: ok });
  }

  if (method === "GET" && path === "/api/scans") {
    const sid = url.searchParams.get("sourceId") ?? undefined;
    return sendJson(res, 200, await service.listScans(sid));
  }

  const scanId = path.match(/^\/api\/scans\/([^/]+)$/);
  if (method === "GET" && scanId) {
    const scan = await service.getScan(decodeURIComponent(scanId[1]!));
    return sendJson(res, scan ? 200 : 404, scan ?? { error: "not found" });
  }

  if (method === "GET" && path === "/api/chat/available") {
    return sendJson(res, 200, { available: await service.chatAvailable() });
  }

  // Streaming chat over Server-Sent Events.
  if (method === "POST" && path === "/api/chat") {
    const body = await readJsonBody(req);
    if (!body?.message) return sendJson(res, 400, { error: "message is required" });
    const threadId = String(body.threadId ?? "default");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    try {
      for await (const ev of service.chatStream(threadId, String(body.message))) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`);
    }
    res.end();
    return;
  }

  sendJson(res, 404, { error: `No route for ${method} ${path}` });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify(body, (_k, v) => (v instanceof Date ? v.toISOString() : v)),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Read the raw request body as a string (for large getMongoData log uploads). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Read the raw request body as a Buffer (for binary FTDC uploads). */
async function readRawBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
