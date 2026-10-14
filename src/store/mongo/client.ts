import { MongoClient, type Db } from "mongodb";

/**
 * Shared MongoClient for the app's own stores (sources, scans, audit).
 *
 * Created ONCE and reused across all stores (connection pooling best practice).
 * This is the app's control-plane store — a single long-running process doing
 * small, infrequent reads/writes per scan (OLTP-ish, low concurrency), so the
 * pool is intentionally small.
 */
let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

export function mongoStoreUri(): string | undefined {
  // Reuse the MCP server's connection string if set, else a dedicated var.
  return process.env.PS_AGENT_MONGO_URI ?? process.env.MDB_MCP_CONNECTION_STRING;
}

export function mongoStoreDbName(): string {
  return process.env.PS_AGENT_MONGO_DB ?? "ps_agent";
}

/** Returns true if a MongoDB-backed store is configured. */
export function mongoStoreEnabled(): boolean {
  return Boolean(mongoStoreUri());
}

/** Lazily connect (once) and return the shared client. */
export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  if (connecting) return connecting;

  const uri = mongoStoreUri();
  if (!uri) throw new Error("No MongoDB store URI (set PS_AGENT_MONGO_URI).");

  const c = new MongoClient(uri, {
    appName: "ps-agent-store",
    // Low-concurrency control-plane workload for a single app instance:
    maxPoolSize: 10, // ample headroom for our tiny store op rate
    minPoolSize: 1, // keep one warm connection ready
    maxIdleTimeMS: 300_000, // 5 min — stable long-running server
    serverSelectionTimeoutMS: 5_000, // fail fast on topology issues
    connectTimeoutMS: 8_000,
    socketTimeoutMS: 30_000, // short OLTP store ops
  });

  connecting = c.connect().then((connected) => {
    client = connected;
    connecting = null;
    return connected;
  });
  return connecting;
}

export async function getMongoDb(): Promise<Db> {
  const c = await getMongoClient();
  return c.db(mongoStoreDbName());
}

/** Close the shared client (on process shutdown). */
export async function closeMongoClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
