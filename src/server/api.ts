import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HealthService } from "../service/healthService.js";
import { renderDashboard } from "./dashboard.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { bus, type AgentEvent } from "../events/bus.js";
import { closeMongoClient } from "../store/mongo/client.js";

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
