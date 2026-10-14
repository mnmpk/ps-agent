import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SourceSchema, type Source } from "../core/source.js";
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto.js";

/**
 * Persists the set of registered deployments (sources). Separate from the scan
 * store so credentials and scan snapshots have different lifecycles.
 *
 * NOTE: connection strings are stored as-is here for the local dev dashboard.
 * The design (DESIGN.md §9) calls for encryption at rest before this is used
 * beyond local/single-user; that lands in the hardening phase.
 */
export interface SourceStore {
  list(): Promise<Source[]>;
  get(id: string): Promise<Source | null>;
  upsert(source: Source): Promise<Source>;
  remove(id: string): Promise<boolean>;
}

export class FileSourceStore implements SourceStore {
  private readonly file: string;
  /**
   * Serializes all read-modify-write cycles. Without this, a register (write)
   * and a concurrent scan/scheduler read-modify-write could clobber each other,
   * losing the just-registered source ("Source … not found" on the next scan).
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(file?: string) {
    const dir = process.env.PS_AGENT_DATA_DIR
      ? process.env.PS_AGENT_DATA_DIR
      : join(homedir(), ".ps-agent");
    this.file = file ?? join(dir, "sources.json");
  }

  /** Run a mutating op exclusively (one at a time) to avoid lost updates. */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op, op);
    // Keep the chain alive even if an op rejects.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async readAll(): Promise<Source[]> {
    if (!existsSync(this.file)) return [];
    let parsed: unknown[];
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown[];
    } catch {
      return [];
    }
    // Per-record decrypt; skip (warn) any record we can't decrypt so one bad
    // record never drops the whole fleet.
    return decryptSources(parsed as Source[]);
  }

  /** Atomic write: write to a temp file, then rename over the target. */
  private async writeAll(sources: Source[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const onDisk = sources.map(encryptSource);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(onDisk, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  async list(): Promise<Source[]> {
    return this.readAll();
  }

  async get(id: string): Promise<Source | null> {
    const all = await this.readAll();
    return all.find((s) => s.id === id) ?? null;
  }

  async upsert(source: Source): Promise<Source> {
    const parsed = SourceSchema.parse(source);
    return this.serialize(async () => {
      const all = await this.readAll();
      const idx = all.findIndex((s) => s.id === parsed.id);
      if (idx >= 0) all[idx] = parsed;
      else all.push(parsed);
      await this.writeAll(all);
      return parsed;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const all = await this.readAll();
      const next = all.filter((s) => s.id !== id);
      if (next.length === all.length) return false;
      await this.writeAll(next);
      return true;
    });
  }
}

/** Redact secrets before sending a source to any client. */
export function redactSource(source: Source): Source {
  const redacted: Source = { ...source };
  if (redacted.connectionString) {
    redacted.connectionString = redactConnectionString(redacted.connectionString);
  }
  if (redacted.atlas) {
    redacted.atlas = { ...redacted.atlas, privateKey: "***", publicKey: "***" };
  }
  if (redacted.opsManager) {
    redacted.opsManager = { ...redacted.opsManager, privateKey: "***", publicKey: "***" };
  }
  return redacted;
}

/** Mask credentials in a mongodb connection string. */
export function redactConnectionString(uri: string): string {
  // mongodb+srv://user:pass@host/... → mongodb+srv://user:***@host/...
  return uri.replace(/(\/\/[^:@/]+:)([^@]+)(@)/, "$1***$3");
}

/** Encrypt the secret-bearing fields of a source for at-rest storage. */
export function encryptSource(source: Source): Source {
  const out: Source = { ...source };
  if (out.connectionString && !isEncrypted(out.connectionString)) {
    out.connectionString = encryptSecret(out.connectionString);
  }
  if (out.atlas) {
    out.atlas = {
      ...out.atlas,
      privateKey: isEncrypted(out.atlas.privateKey)
        ? out.atlas.privateKey
        : encryptSecret(out.atlas.privateKey),
    };
  }
  if (out.opsManager) {
    out.opsManager = {
      ...out.opsManager,
      privateKey: isEncrypted(out.opsManager.privateKey)
        ? out.opsManager.privateKey
        : encryptSecret(out.opsManager.privateKey),
    };
  }
  return out;
}

/**
 * Decrypt the secret-bearing fields of a source read from storage.
 *
 * Throws `UndecryptableSourceError` if a secret cannot be decrypted (e.g. the
 * encryption key changed or the record is corrupt). Stores catch this and skip
 * the record with a warning rather than crashing — one bad record must never
 * take down startup.
 */
export function decryptSource(source: Source): Source {
  const out: Source = { ...source };
  try {
    if (out.connectionString) out.connectionString = decryptSecret(out.connectionString);
    if (out.atlas) {
      out.atlas = { ...out.atlas, privateKey: decryptSecret(out.atlas.privateKey) };
    }
    if (out.opsManager) {
      out.opsManager = { ...out.opsManager, privateKey: decryptSecret(out.opsManager.privateKey) };
    }
  } catch (err) {
    throw new UndecryptableSourceError(source.id, (err as Error).message);
  }
  return out;
}

export class UndecryptableSourceError extends Error {
  constructor(
    public readonly sourceId: string,
    reason: string,
  ) {
    super(
      `Cannot decrypt secrets for source ${sourceId} (${reason}). ` +
        `Likely the encryption key changed (PS_AGENT_SECRET_KEY / secret.key).`,
    );
    this.name = "UndecryptableSourceError";
  }
}

/**
 * Decrypt + validate a batch of raw source records, skipping (and warning on)
 * any that can't be decrypted or parsed. Shared by the file and Mongo stores.
 */
export function decryptSources(raw: Source[]): Source[] {
  const out: Source[] = [];
  for (const rec of raw) {
    let decrypted: Source;
    try {
      decrypted = decryptSource(rec);
    } catch (err) {
      process.stderr.write(`[sourceStore] skipping record: ${(err as Error).message}\n`);
      continue;
    }
    const parsed = SourceSchema.safeParse(decrypted);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
