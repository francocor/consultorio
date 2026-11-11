import {
  auditProblems,
  clusterProblems,
  planRevert,
  type ClusterFacts,
  type ScratchFacts,
} from './restore-audit.js';

/** What the audit of a restore reads from the cluster (a `PostgresCluster` has all of it). */
export interface AuditCluster {
  clusterFacts: (auditDatabase: string | null) => Promise<ClusterFacts>;
  scratchFacts: (name: string) => Promise<ScratchFacts>;
  executeStatements: (statements: readonly string[]) => Promise<void>;
}

export interface RestoreAudit {
  snapshot: () => Promise<unknown>;
  check: (snapshot: unknown) => Promise<string[]>;
  revert: (snapshot: unknown) => Promise<void>;
}

/**
 * The audit of a restore: the roles of the cluster before it (`snapshot`), what is wrong with them and with the
 * scratch database after the migrations (`check`), and the way back (`revert`). Kept apart from the controller so
 * that the very code that runs in the product is the one the tests of a hostile backup run.
 */
export function createRestoreAudit(
  cluster: AuditCluster,
  names: { live: string; scratch: string },
  ownerPassword: () => string,
): RestoreAudit {
  return {
    snapshot: () => cluster.clusterFacts(names.live),
    check: async (snapshot) => {
      const before = snapshot as ClusterFacts;
      // The roles first, from the superuser side alone: a hook that changed the password of app_owner or gave it a
      // timeout makes every read through it fail, and that must be a finding and not an exception.
      const roleProblems = clusterProblems(before, await cluster.clusterFacts(null));
      if (roleProblems.length > 0) return roleProblems;
      return auditProblems(
        before,
        await cluster.clusterFacts(names.scratch),
        await cluster.scratchFacts(names.scratch),
      );
    },
    revert: async (snapshot) => {
      const now = await cluster.clusterFacts(null);
      const plan = planRevert(snapshot as ClusterFacts, now, ownerPassword());
      const problems: string[] = [];
      try {
        await cluster.executeStatements(plan.statements);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      problems.push(...plan.skipped);
      if (problems.length > 0) {
        throw new Error(`the roles could not be put back completely: ${problems.join(' | ')}`);
      }
    },
  };
}
