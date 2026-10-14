/**
 * Importing this module registers all built-in checks as a side effect.
 * Keep these imports — removing one disables that check.
 */
import "./availability.js";
import "./replication.js";
import "./resource.js";
import "./configuration.js";
import "./atlas.js";
import "./storage.js";

export * from "./registry.js";
export { scoreFindings } from "./score.js";
