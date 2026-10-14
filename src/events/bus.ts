import { EventEmitter } from "node:events";

/** Lifecycle + telemetry events emitted during scans and scheduling. */
export type AgentEvent =
  | { type: "scan.started"; sourceId: string; sourceName: string; at: string }
  | { type: "scan.progress"; sourceId: string; step: string; at: string }
  | {
      type: "scan.completed";
      sourceId: string;
      sourceName: string;
      scoreValue: number;
      findingCount: number;
      at: string;
    }
  | { type: "scan.failed"; sourceId: string; error: string; at: string }
  | { type: "schedule.changed"; sourceId: string; intervalSeconds?: number; enabled: boolean; at: string };

/**
 * Process-wide event bus. The scan pipeline and scheduler publish here; the
 * HTTP layer subscribes and forwards to clients over SSE. Kept intentionally
 * simple (in-process EventEmitter) — a distributed deployment would back this
 * with Redis pub/sub without changing publishers/subscribers.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients may subscribe; avoid the default 10-listener warning.
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}

/** Shared singleton bus used across the app. */
export const bus = new EventBus();
