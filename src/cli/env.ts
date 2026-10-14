import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads environment variables from a .env file (if present) before the app
 * reads process.env. Existing process.env values take precedence (so explicit
 * shell env / CI vars are never overridden by the file).
 *
 * Prefers Node's built-in process.loadEnvFile (Node 20.6+), falling back to a
 * minimal parser. No external dependency.
 */
export function loadDotEnv(path = ".env"): void {
  const file = resolve(process.cwd(), path);
  if (!existsSync(file)) return;

  // Snapshot keys already set so the file never overrides real env.
  const preexisting = new Set(Object.keys(process.env));

  try {
    // Built-in loader (Node 20.6+). It may override, so we restore below.
    if (typeof process.loadEnvFile === "function") {
      const before: Record<string, string | undefined> = {};
      for (const k of preexisting) before[k] = process.env[k];
      process.loadEnvFile(file);
      // Restore any pre-existing vars the loader may have overwritten.
      for (const k of preexisting) {
        if (before[k] !== undefined) process.env[k] = before[k];
      }
      return;
    }
  } catch {
    // fall through to manual parse
  }

  for (const [key, value] of parseEnv(readFileSync(file, "utf8"))) {
    if (!preexisting.has(key)) process.env[key] = value;
  }
}

/** Minimal KEY=VALUE parser (supports quotes, comments, blank lines). */
function parseEnv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out.push([key, value]);
  }
  return out;
}
