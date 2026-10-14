import type { Finding, IndexUsage } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/** Server running an end-of-life major.minor version. */
register({
  id: "config.eol-version",
  category: "configuration",
  title: "End-of-life server version",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    // Works for both direct (serverStatus) and Atlas (topology) sources.
    const version = facts.serverStatus?.version ?? facts.topology.mongoVersion;
    if (!version || version === "0.0.0") return [];
    const parts = version.split(".");
    const majorMinor = `${parts[0] ?? "0"}.${parts[1] ?? "0"}`;
    if (!thresholds.eolVersions.includes(majorMinor)) return [];
    return [
      {
        checkId: "config.eol-version",
        category: "configuration",
        severity: "warning",
        title: `MongoDB ${version} is end-of-life`,
        detail: `Version ${majorMinor} no longer receives security patches. Plan an upgrade to a supported release.`,
        evidence: { version, majorMinor },
        docs: "https://www.mongodb.com/support-policy/lifecycles",
      },
    ];
  },
});

/** Authentication disabled. */
register({
  id: "config.auth-disabled",
  category: "configuration",
  title: "Authentication disabled",
  evaluate({ facts }: CheckContext): Finding[] {
    const sec = facts.serverStatus?.security;
    if (!sec || sec.authEnabled) return [];
    return [
      {
        checkId: "config.auth-disabled",
        category: "configuration",
        severity: "critical",
        title: "Access control (authentication) is not enabled",
        detail:
          "The deployment accepts unauthenticated connections. Anyone with network access has full database access.",
        evidence: { authEnabled: sec.authEnabled },
        remediation: "Enable access control and create least-privilege users.",
        docs: "https://www.mongodb.com/docs/manual/core/authentication/",
      },
    ];
  },
});

/** TLS disabled. */
register({
  id: "config.tls-disabled",
  category: "configuration",
  title: "TLS disabled",
  evaluate({ facts }: CheckContext): Finding[] {
    const sec = facts.serverStatus?.security;
    if (!sec || sec.tlsEnabled) return [];
    return [
      {
        checkId: "config.tls-disabled",
        category: "configuration",
        severity: "warning",
        title: "TLS/SSL is not enabled",
        detail: "Client/intra-cluster traffic is unencrypted and vulnerable to interception.",
        evidence: { tlsEnabled: sec.tlsEnabled },
        remediation: "Configure TLS for client and replication connections.",
      },
    ];
  },
});

/** Unused indexes wasting write throughput and storage. */
register({
  id: "index.unused",
  category: "query",
  title: "Unused indexes",
  evaluate({ facts, thresholds }: CheckContext): Finding[] {
    const usage = facts.indexUsage;
    if (!usage) return [];
    const unused = usage.filter(
      (i) => i.name !== "_id_" && i.ops <= thresholds.unusedIndexMinScanOps,
    );
    if (unused.length === 0) return [];
    return [
      {
        checkId: "index.unused",
        category: "query",
        severity: "info",
        title: `${unused.length} unused index(es) detected`,
        detail:
          "These indexes received no operations since stats were last reset. Unused indexes still slow writes and consume storage.",
        evidence: {
          indexes: unused.map((i) => `${i.db}.${i.collection}:${i.name}`).slice(0, 50),
          totalUnused: unused.length,
        },
        remediation:
          "Confirm over a representative period, then drop indexes that remain unused.",
      },
    ];
  },
});

/** Redundant indexes whose keys are a prefix of another index. */
register({
  id: "index.redundant",
  category: "query",
  title: "Redundant indexes",
  evaluate({ facts }: CheckContext): Finding[] {
    const usage = facts.indexUsage;
    if (!usage) return [];
    const byColl = new Map<string, IndexUsage[]>();
    for (const i of usage) {
      const key = `${i.db}.${i.collection}`;
      (byColl.get(key) ?? byColl.set(key, []).get(key)!).push(i);
    }
    const redundant: string[] = [];
    for (const [coll, idxs] of byColl) {
      for (const a of idxs) {
        if (a.name === "_id_") continue;
        for (const b of idxs) {
          if (a === b || b.name === "_id_") continue;
          if (isPrefixOf(a.keys, b.keys)) {
            redundant.push(`${coll}: ${a.name} is a prefix of ${b.name}`);
          }
        }
      }
    }
    if (redundant.length === 0) return [];
    return [
      {
        checkId: "index.redundant",
        category: "query",
        severity: "info",
        title: `${redundant.length} redundant index relationship(s)`,
        detail:
          "An index whose key pattern is a prefix of another compound index is usually redundant and can be dropped.",
        evidence: { relationships: redundant.slice(0, 50) },
      },
    ];
  },
});

/** Is index key pattern `a` an ordered prefix of `b`? */
function isPrefixOf(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.entries(a);
  const bk = Object.entries(b);
  if (ak.length === 0 || ak.length >= bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const [af, ad] = ak[i]!;
    const [bf, bd] = bk[i]!;
    if (af !== bf || ad !== bd) return false;
  }
  return true;
}
