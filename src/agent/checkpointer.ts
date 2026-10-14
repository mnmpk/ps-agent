import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { getMongoClient, mongoStoreDbName, mongoStoreEnabled } from "../store/mongo/client.js";

/**
 * Resolves the LangGraph checkpointer (chat memory backend).
 *
 * - When a MongoDB store is configured, chat threads persist in MongoDB via
 *   `MongoDBSaver` (collections `chat_checkpoints` / `chat_checkpoint_writes`
 *   in the `ps_agent` db), so conversations survive restarts.
 * - Otherwise falls back to an in-memory `MemorySaver` (lost on restart).
 *
 * The saver package is an optional dependency, imported lazily; if it is
 * missing we degrade to MemorySaver rather than failing chat.
 */
export async function createCheckpointer(): Promise<BaseCheckpointSaver> {
  if (!mongoStoreEnabled()) return new MemorySaver();

  try {
    const mod = await import("@langchain/langgraph-checkpoint-mongodb");
    const { MongoDBSaver } = mod as typeof import("@langchain/langgraph-checkpoint-mongodb");
    const client = await getMongoClient();
    return new MongoDBSaver({
      client,
      dbName: mongoStoreDbName(),
      checkpointCollectionName: "chat_checkpoints",
      checkpointWritesCollectionName: "chat_checkpoint_writes",
    });
  } catch {
    // SDK missing or incompatible — don't break chat, just lose persistence.
    return new MemorySaver();
  }
}
