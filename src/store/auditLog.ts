import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only audit log (DESIGN.md §9). Records security-relevant actions:
 * source registration/removal, config changes, scans, and chat tool calls.
 * Stored as JSON Lines so it is append-only and tail-friendly.
 *
 * Secrets are never written here — callers pass already-redacted detail.
 */
export type AuditAction =
  | "source.register"
  | "source.remove"
  | "source.config"
  | "scan.run"
  | "chat.tool";

export interface AuditEntry {
  at: string; // ISO timestamp
  action: AuditAction;
  sourceId?: string;
  actor?: string; // reserved for future auth; "system"/"cli"/"api" for now
  detail?: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "at">): Promise<void>;
  tail(limit?: number): Promise<AuditEntry[]>;
}

export class FileAuditLog implements AuditLog {
  private readonly file: string;

  constructor(file?: string) {
    const dir = process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent");
    this.file = file ?? join(dir, "audit.log");
  }

  async record(entry: Omit<AuditEntry, "at">): Promise<void> {
    const full: AuditEntry = { at: new Date().toISOString(), ...entry };
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(full) + "\n", "utf8");
  }

  async tail(limit = 100): Promise<AuditEntry[]> {
    if (!existsSync(this.file)) return [];
    const raw = await readFile(this.file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const slice = lines.slice(-limit);
    const out: AuditEntry[] = [];
    for (const l of slice) {
      try {
        out.push(JSON.parse(l) as AuditEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }
}

/** No-op audit log for tests / when auditing is disabled. */
export class NullAuditLog implements AuditLog {
  async record(): Promise<void> {}
  async tail(): Promise<AuditEntry[]> {
    return [];
  }
}
