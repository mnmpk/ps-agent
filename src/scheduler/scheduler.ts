import type { HealthService } from "../service/healthService.js";
import type { Source } from "../core/source.js";

interface Job {
  sourceId: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
  running: boolean;
}

export interface SchedulerOptions {
  /** Add +/- this fraction of jitter to each interval (default 0.1 = ±10%). */
  jitter?: number;
  /** Run LLM summarization on scheduled scans (default false — cost/latency). */
  summarize?: boolean;
  /** Minimum allowed interval in seconds (guard, default 15). */
  minIntervalSeconds?: number;
}

/**
 * In-process scheduler: one repeatable job per source with a configured
 * cadence. Deliberately simple (setTimeout-based) so there is no Redis/queue
 * dependency for the single-process app. The HealthService is the only
 * surface it touches, so a BullMQ/Redis-backed implementation can replace this
 * class without changing callers.
 *
 * - Jitter spreads jobs to avoid a thundering herd (and respects Atlas rate limits).
 * - Overlap guard: a source never has two concurrent scheduled scans.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly jitter: number;
  private readonly summarize: boolean;
  private readonly minIntervalMs: number;

  constructor(
    private readonly service: HealthService,
    options: SchedulerOptions = {},
  ) {
    this.jitter = options.jitter ?? 0.1;
    this.summarize = options.summarize ?? false;
    this.minIntervalMs = (options.minIntervalSeconds ?? 15) * 1000;
  }

  /** (Re)load schedules from the registered sources. */
  async sync(): Promise<void> {
    const sources = await this.service.listSourcesRaw();
    const wanted = new Set<string>();
    for (const s of sources) {
      const interval = this.effectiveIntervalMs(s);
      if (interval == null) continue;
      wanted.add(s.id);
      this.ensureJob(s.id, interval);
    }
    // Remove jobs for sources no longer scheduled.
    for (const id of [...this.jobs.keys()]) {
      if (!wanted.has(id)) this.remove(id);
    }
  }

  /** Number of active scheduled jobs. */
  get size(): number {
    return this.jobs.size;
  }

  stopAll(): void {
    for (const id of [...this.jobs.keys()]) this.remove(id);
  }

  // --- internals -----------------------------------------------------------

  private effectiveIntervalMs(source: Source): number | null {
    const sched = source.schedule;
    if (!sched || sched.enabled === false || !sched.intervalSeconds) return null;
    return Math.max(this.minIntervalMs, sched.intervalSeconds * 1000);
  }

  private ensureJob(sourceId: string, intervalMs: number): void {
    const existing = this.jobs.get(sourceId);
    if (existing && existing.intervalMs === intervalMs) return;
    if (existing) this.remove(sourceId);
    this.schedule(sourceId, intervalMs);
  }

  private schedule(sourceId: string, intervalMs: number): void {
    const delay = this.withJitter(intervalMs);
    const timer = setTimeout(() => this.fire(sourceId), delay);
    // Don't keep the process alive solely for the scheduler.
    if (typeof timer.unref === "function") timer.unref();
    this.jobs.set(sourceId, { sourceId, intervalMs, timer, running: false });
  }

  private async fire(sourceId: string): Promise<void> {
    const job = this.jobs.get(sourceId);
    if (!job) return;
    if (!job.running) {
      job.running = true;
      try {
        await this.service.scanSource(sourceId, this.summarize, { emitEvents: true });
      } catch {
        // Errors are emitted as scan.failed by the pipeline; swallow here.
      } finally {
        job.running = false;
      }
    }
    // Reschedule the next run (if the job still exists).
    if (this.jobs.has(sourceId)) this.schedule(sourceId, job.intervalMs);
  }

  private remove(sourceId: string): void {
    const job = this.jobs.get(sourceId);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(sourceId);
  }

  private withJitter(ms: number): number {
    const delta = ms * this.jitter;
    return Math.round(ms - delta + Math.random() * 2 * delta);
  }
}
