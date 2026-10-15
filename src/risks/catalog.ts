import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RiskCatalogEntry } from "./types.js";

/**
 * Loads the committed SEED risk catalog (generated from the expert risk register
 * .xlsx by scripts/convertRiskRegister.ts). This is the default/seed data; the
 * mutable runtime catalog lives in the CatalogStore. Cached after first load.
 */
let cache: RiskCatalogEntry[] | null = null;

export function loadSeedCatalog(): RiskCatalogEntry[] {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  // Catalog ships alongside the source/dist as risks-catalog.json.
  const candidates = [
    join(here, "risks-catalog.json"),
    join(here, "../../src/risks/risks-catalog.json"),
  ];
  for (const path of candidates) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { risks: RiskCatalogEntry[] };
      cache = data.risks ?? [];
      return cache;
    } catch {
      /* try next */
    }
  }
  cache = [];
  return cache;
}

/**
 * The "active" catalog used by synchronous scan-time risk findings. The service
 * refreshes this from the CatalogStore; until then it falls back to the seed.
 * Only ENABLED entries should be set here (disabled risks are skipped).
 */
let active: RiskCatalogEntry[] | null = null;

export function setActiveCatalog(entries: RiskCatalogEntry[]): void {
  active = entries;
}

export function getActiveCatalog(): RiskCatalogEntry[] {
  return active ?? loadSeedCatalog().filter((r) => r.enabled !== false);
}
