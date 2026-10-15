/**
 * Node-identity reconciliation across heterogeneous diagnostic sources.
 *
 * The three offline inputs name the same physical node differently:
 *   - getMongoData replSetStatus.members[].name → "host:port" (often an FQDN)
 *   - FTDC serverStatus/hostInfo hostname        → "host:port" or bare host
 *   - mdiag hostname                             → bare hostname (short or FQDN)
 *
 * Without reconciliation a single node shows up 2–3 times in the UI. We map each
 * observed id onto a CANONICAL name (preferring a replica-set member name when
 * available) so each node appears once.
 */

/** Split "host:port" → { host, port }. Bare host → port undefined. */
function splitHostPort(id: string): { host: string; port?: string } {
  const i = id.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(id.slice(i + 1))) {
    return { host: id.slice(0, i), port: id.slice(i + 1) };
  }
  return { host: id };
}

/** Short hostname (first label) for FQDN-vs-short comparison. */
function shortHost(host: string): string {
  return host.split(".")[0]!.toLowerCase();
}

/**
 * Score how well an observed node id matches a canonical member name.
 * Higher is better; 0 means no match. Used to pick the best canonical name.
 */
function matchScore(observed: string, canonical: string): number {
  if (observed === canonical) return 100;
  const o = splitHostPort(observed);
  const c = splitHostPort(canonical);
  const oh = o.host.toLowerCase();
  const ch = c.host.toLowerCase();

  // Exact host match (ignoring port differences).
  if (oh === ch) return o.port && c.port && o.port === c.port ? 90 : 80;
  // One is an FQDN of the other (node1 ⟷ node1.example.net).
  if (ch.startsWith(oh + ".") || oh.startsWith(ch + ".")) return 70;
  // Short hostnames match (node1 ⟷ node1).
  if (shortHost(oh) === shortHost(ch)) return 60;
  return 0;
}

export interface NodeReconciler {
  /** Add authoritative canonical names (e.g. replica-set members) to the roster. */
  seedRoster(names: string[]): void;
  /** Map an observed id to its canonical name (best member match, else itself). */
  canonical(observed: string): string;
  /** All canonical names seen so far, in insertion order. */
  list(): string[];
  /** Register an observed id (dedupes onto its canonical form). */
  add(observed: string): string;
}

/**
 * Build a reconciler. Seed it with a roster of canonical member names (typically
 * `replSetStatus.members[].name` from getMongoData) via the constructor or
 * `seedRoster`. Observed ids that don't confidently match any roster entry
 * become their own canonical node.
 */
export function createNodeReconciler(roster: string[] = []): NodeReconciler {
  const canonicalNames: string[] = [];
  const seen = new Set<string>();
  const rosterNames: string[] = [];
  const cache = new Map<string, string>();

  const register = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      canonicalNames.push(name);
    }
  };

  const seedRoster = (names: string[]): void => {
    let changed = false;
    for (const n of names) {
      if (n && !rosterNames.includes(n)) {
        rosterNames.push(n);
        register(n); // members always appear, even with no metrics yet
        changed = true;
      }
    }
    // A later roster seed can change earlier resolutions; clear the cache.
    if (changed) cache.clear();
  };

  const canonical = (observed: string): string => {
    if (!observed) return observed;
    const hit = cache.get(observed);
    if (hit) return hit;
    let best = observed;
    let bestScore = 0;
    for (const name of rosterNames) {
      const s = matchScore(observed, name);
      if (s > bestScore) {
        bestScore = s;
        best = name;
      }
    }
    // Require a reasonably confident match to collapse onto a roster name.
    const resolved = bestScore >= 60 ? best : observed;
    cache.set(observed, resolved);
    return resolved;
  };

  seedRoster(roster);

  return {
    seedRoster,
    canonical,
    list: () => [...canonicalNames],
    add: (observed: string) => {
      const name = canonical(observed);
      register(name);
      return name;
    },
  };
}
