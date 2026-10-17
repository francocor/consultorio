import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { listDefinerFunctions, pinsSearchPath } from '../support/function-catalog.js';

/**
 * Security review finding 4: a SECURITY DEFINER function runs with the rights of its owner, which
 * owns every table. Who may call each one is therefore a decision. This test fails when a new
 * definer function is added without an entry here, when one can be run by PUBLIC, by a role that
 * has no business with it, or when it does not pin its search path.
 */
const CHECKED_ROLES = ['app_rw', 'app_operator', 'audit_sealer'] as const;

/** The only roles allowed to run each definer function, and why. */
const ALLOWED: Record<string, readonly string[]> = {
  // Sign-in looks the account up before any tenant is known (the runtime role).
  'app.lookup_user_for_login(citext)': ['app_rw'],
  // Ends a user's sessions in every organization when their password changes (runtime role).
  'app.revoke_user_sessions(uuid,text,timestamp with time zone,uuid)': ['app_rw'],
  // Written right after a professional saves an anamnesis (runtime role).
  'app.set_patient_safety_flags(uuid,uuid,text[])': ['app_rw'],
  // The worker creates next month's audit partitions (runtime role).
  'app.ensure_audit_partitions(integer,date)': ['app_rw'],
  // Support grants and unclaimed organizations belong to the operator console.
  'app.active_support_grant(uuid)': ['app_operator'],
  'app.active_support_grant_id(uuid)': ['app_operator'],
  'app.tenant_is_unclaimed(uuid)': ['app_operator'],
  'app.demo_reset(uuid)': ['app_operator'],
  // Called only by triggers, never directly.
  'app.care_adjust(uuid,uuid,uuid,integer,integer)': [],
  'app.care_assignment_sync()': [],
  'app.care_set_assigned(uuid,uuid,uuid,boolean)': [],
};

let owner: pg.Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

describe('SECURITY DEFINER functions in schema app', () => {
  it('lists every definer function here, so adding one is a decision', async () => {
    const found = await listDefinerFunctions(owner, 'app', CHECKED_ROLES);

    expect(found.map((fn) => fn.signature).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('pins the search path: pg_catalog first and pg_temp last, so neither a schema nor a temporary table can shadow', async () => {
    const found = await listDefinerFunctions(owner, 'app', CHECKED_ROLES);

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((fn) => !pinsSearchPath(fn.config)).map((fn) => fn.signature)).toEqual([]);
  });

  it('is not executable by PUBLIC', async () => {
    const found = await listDefinerFunctions(owner, 'app', CHECKED_ROLES);

    expect(found.filter((fn) => fn.publicExecute).map((fn) => fn.signature)).toEqual([]);
  });

  it('is executable only by the roles that need it: not app_rw, app_operator or audit_sealer by accident', async () => {
    const found = await listDefinerFunctions(owner, 'app', CHECKED_ROLES);

    const unexpected = found
      .filter((fn) => ALLOWED[fn.signature] !== undefined)
      .map((fn) => ({
        signature: fn.signature,
        executableBy: fn.executableBy,
        allowed: [...(ALLOWED[fn.signature] ?? [])].sort(),
      }))
      .filter((fn) => JSON.stringify(fn.executableBy) !== JSON.stringify(fn.allowed));

    expect(unexpected).toEqual([]);
  });

  it('makes a new function in schema app unusable by anyone until a migration grants it', async () => {
    await owner.query(
      `CREATE FUNCTION app.zz_scratch_definer() RETURNS integer
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`,
    );
    try {
      const found = await listDefinerFunctions(owner, 'app', CHECKED_ROLES);
      const scratch = found.find((fn) => fn.signature === 'app.zz_scratch_definer()');

      expect(scratch).toMatchObject({ publicExecute: false, executableBy: [] });
    } finally {
      await owner.query('DROP FUNCTION app.zz_scratch_definer()');
    }
  });
});
