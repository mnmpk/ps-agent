import type { Finding } from "../core/types.js";
import { register, type CheckContext } from "./registry.js";

/** No primary present in the replica set. */
register({
  id: "repl.no-primary",
  category: "availability",
  title: "No primary elected",
  evaluate({ facts }: CheckContext): Finding[] {
    const repl = facts.replSetStatus;
    if (!repl) return [];
    const hasPrimary = repl.members.some((m) => m.state === 1);
    if (hasPrimary) return [];
    return [
      {
        checkId: "repl.no-primary",
        category: "availability",
        severity: "critical",
        title: "Replica set has no primary",
        detail:
          "No member is in PRIMARY state. Writes are currently rejected and the set is unavailable for writes until an election completes.",
        evidence: {
          set: repl.set,
          memberStates: repl.members.map((m) => ({ name: m.name, state: m.stateStr })),
        },
        remediation:
          "Check network connectivity between members and that a majority of voting members are reachable.",
      },
    ];
  },
});

/** Any member unreachable / unhealthy. */
register({
  id: "repl.member-unhealthy",
  category: "availability",
  title: "Unhealthy replica set member",
  evaluate({ facts }: CheckContext): Finding[] {
    const repl = facts.replSetStatus;
    if (!repl) return [];
    const bad = repl.members.filter(
      (m) => m.health === 0 || ["DOWN", "REMOVED", "ROLLBACK"].includes(m.stateStr),
    );
    if (bad.length === 0) return [];
    return [
      {
        checkId: "repl.member-unhealthy",
        category: "availability",
        severity: "critical",
        title: `${bad.length} replica set member(s) unhealthy`,
        detail: `Members not reporting healthy: ${bad
          .map((m) => `${m.name} (${m.stateStr})`)
          .join(", ")}.`,
        evidence: { members: bad.map((m) => ({ name: m.name, state: m.stateStr, health: m.health })) },
        remediation: "Investigate the affected node's mongod logs and host health.",
      },
    ];
  },
});

/** Majority of voting members at risk → set could lose write availability. */
register({
  id: "repl.majority-at-risk",
  category: "availability",
  title: "Write-majority at risk",
  evaluate({ facts }: CheckContext): Finding[] {
    const repl = facts.replSetStatus;
    if (!repl) return [];
    const voters = repl.members.filter((m) => m.votes > 0);
    const healthyVoters = voters.filter((m) => m.health === 1 && [1, 2, 7].includes(m.state));
    const majority = Math.floor(voters.length / 2) + 1;
    if (voters.length === 0 || healthyVoters.length >= majority) return [];
    return [
      {
        checkId: "repl.majority-at-risk",
        category: "availability",
        severity: "critical",
        title: "Fewer than a majority of voting members are healthy",
        detail: `${healthyVoters.length}/${voters.length} voting members healthy; a majority of ${majority} is required to elect/retain a primary.`,
        evidence: { voters: voters.length, healthyVoters: healthyVoters.length, majority },
      },
    ];
  },
});

/** Even number of voting members → election tie risk. */
register({
  id: "repl.even-voters",
  category: "configuration",
  title: "Even number of voting members",
  evaluate({ facts }: CheckContext): Finding[] {
    const repl = facts.replSetStatus;
    if (!repl) return [];
    const voters = repl.members.filter((m) => m.votes > 0).length;
    if (voters < 2 || voters % 2 === 1) return [];
    return [
      {
        checkId: "repl.even-voters",
        category: "configuration",
        severity: "warning",
        title: `Replica set has an even number of voting members (${voters})`,
        detail:
          "An even number of voters can cause election ties. Add an arbiter or data-bearing member to make the voter count odd.",
        evidence: { votingMembers: voters },
      },
    ];
  },
});
