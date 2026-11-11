import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ALLOWLIST as allowlist } from '../policy/no-delete-allowlist.js';

/**
 * The database says the same as the code (tenancy, "No deletion"): the application role can delete
 * rows only from the ephemeral tables listed with a reason. Everything else was revoked, so even a
 * bug that tried to delete a patient, a location or a professional would be refused.
 */
let owner: pg.Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

describe('what the application role may delete', () => {
  it('is exactly the ephemeral tables of the allowlist', async () => {
    const result = await owner.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND has_table_privilege('app_rw', c.oid, 'DELETE')
        ORDER BY 1`,
    );

    expect(result.rows.map((row) => row.name)).toEqual(
      allowlist.ephemeralTables.map((entry) => entry.table).sort(),
    );
  });

  it('cannot truncate anything', async () => {
    const result = await owner.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND has_table_privilege('app_rw', c.oid, 'TRUNCATE')`,
    );

    expect(result.rows.map((row) => row.name)).toEqual([]);
  });
});
