import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let owner: pg.Client;
let runtime: pg.Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  runtime = new pg.Client({ connectionString: inject('runtimeUrl') });
  await Promise.all([owner.connect(), runtime.connect()]);
});

afterAll(async () => {
  await Promise.all([owner.end(), runtime.end()]);
});

describe('database roles', () => {
  it('app_rw is neither superuser, BYPASSRLS, role creator nor database creator', async () => {
    const { rows } = await owner.query<Record<string, boolean>>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
         FROM pg_roles WHERE rolname = 'app_rw'`,
    );

    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
    });
  });

  it('app_rw owns nothing: no table, no schema, not the database', async () => {
    const { rows } = await owner.query<{ owned: string }>(
      `SELECT (SELECT count(*) FROM pg_class WHERE relowner = r.oid)
            + (SELECT count(*) FROM pg_namespace WHERE nspowner = r.oid)
            + (SELECT count(*) FROM pg_database WHERE datdba = r.oid) AS owned
         FROM pg_roles r WHERE r.rolname = 'app_rw'`,
    );

    expect(Number(rows[0]?.owned)).toBe(0);
  });

  it('app_owner owns the database but is not a superuser', async () => {
    const { rows } = await owner.query<{ rolsuper: boolean; owns_database: boolean }>(
      `SELECT r.rolsuper,
              EXISTS (
                SELECT 1 FROM pg_database d
                 WHERE d.datname = current_database() AND d.datdba = r.oid
              ) AS owns_database
         FROM pg_roles r WHERE r.rolname = 'app_owner'`,
    );

    expect(rows[0]).toEqual({ rolsuper: false, owns_database: true });
  });

  it('app_rw cannot create objects in public', async () => {
    await expect(runtime.query('CREATE TABLE public.should_not_exist (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('installs the extensions and the helper schema', async () => {
    const extensions = await owner.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const schema = await owner.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', ['app']);

    expect(extensions.rows.map((row) => row.extname)).toEqual(
      expect.arrayContaining(['btree_gist', 'citext', 'pgcrypto', 'pg_trgm', 'unaccent']),
    );
    expect(schema.rowCount).toBe(1);
  });
});
