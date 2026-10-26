import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { craftDump, type CraftedEntry } from './crafted-dump.js';
import { STAGE_TOOLS, stageAvailable, startTestCluster, type TestCluster } from './pg-testing.js';
import { DATABASE_NAME, type RestoreScratch } from './postgres.js';
import { aclKey } from './restore-acl.js';
import { auditProblems, revertStatements } from './restore-audit.js';
import { spawnRunner } from './runner.js';

/**
 * The restore against a real PostgreSQL. What a dump can do to a cluster is a property of PostgreSQL, so none of
 * this is answered by a fake: the dump is a real `pg_dump`, `pg_restore` is the one of the build, and the SQL that a
 * hostile dump would run is run by the same throwaway role, in the same scratch database.
 */

const SCHEMA = `
  CREATE EXTENSION citext;
  CREATE EXTENSION btree_gist;
  CREATE EXTENSION pg_trgm;
  CREATE EXTENSION unaccent;
  CREATE SCHEMA app;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public, app TO app_rw;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_rw;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  CREATE TABLE patient (id serial PRIMARY KEY, family_name citext NOT NULL);
  CREATE TABLE audit_event (id serial PRIMARY KEY, seq bigint, prev_hash text, hash text, body text);
  REVOKE UPDATE, DELETE ON audit_event FROM app_rw;
  GRANT SELECT ON audit_event TO audit_sealer;
  GRANT UPDATE (seq, prev_hash, hash) ON audit_event TO audit_sealer;
  CREATE FUNCTION app.set_flags(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
  REVOKE ALL ON FUNCTION app.set_flags(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION app.set_flags(uuid) TO app_rw;
  INSERT INTO patient (family_name) VALUES ('Pérez'), ('Gómez');
  ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
  ALTER TABLE patient FORCE ROW LEVEL SECURITY;
  CREATE POLICY everybody ON patient TO app_rw USING (true) WITH CHECK (true);
`;

const SCRATCH = 'consultorio_restore';

const describeReal = stageAvailable() ? describe : describe.skip;

describeReal('a restore into a database owned by a throwaway role', () => {
  let cluster: TestCluster;
  let dump: string;

  const roles = async () => JSON.stringify(await cluster.cluster.clusterFacts(DATABASE_NAME));
  const live = async () =>
    JSON.stringify((await cluster.cluster.aclFacts(DATABASE_NAME)).map(aclKey).sort());
  const restoreRoles = async () =>
    cluster.cluster.asSuperuser('postgres', async (client) => {
      const found = await client.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE pg_catalog.starts_with(rolname, 'consulvia_restore_')",
      );
      return found.rows.map((row) => String(row['rolname']));
    });

  async function pgRestore(scratch: RestoreScratch, archive: string) {
    return spawnRunner(
      join(STAGE_TOOLS, 'pg_restore.exe'),
      [
        '--host=127.0.0.1',
        `--port=${String(cluster.port)}`,
        `--username=${scratch.user}`,
        `--dbname=${scratch.database}`,
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '--exit-on-error',
        '--no-password',
        archive,
      ],
      { env: { ...process.env, PGPASSWORD: scratch.password } },
    );
  }

  /** A hostile backup: an archive whose entries run `statements`, restored by the real `pg_restore` as the throwaway role. */
  async function hostileRestore(scratch: RestoreScratch, statements: string[]) {
    const entries: CraftedEntry[] = statements.map((sql, index) => ({
      tag: `entry ${String(index)}`,
      sql,
    }));
    const archive = join(cluster.folder, `hostile-${String(Date.now())}.dump`);
    writeFileSync(archive, craftDump(entries));
    return pgRestore(scratch, archive);
  }

  /** What a hostile dump does: SQL run by the role that `pg_restore` runs as, in the scratch database. */
  async function asRestorer(scratch: RestoreScratch, statements: string[]) {
    const client = await cluster.connect(scratch.user, scratch.password, scratch.database);
    const failures: string[] = [];
    try {
      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (error) {
          failures.push(`${statement.slice(0, 40)}: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.end();
    }
    return failures;
  }

  beforeAll(async () => {
    cluster = await startTestCluster(SCHEMA);
    dump = join(cluster.folder, 'consultorio.dump');
    const result = await spawnRunner(
      join(STAGE_TOOLS, 'pg_dump.exe'),
      [
        '--host=127.0.0.1',
        `--port=${String(cluster.port)}`,
        '--username=postgres',
        `--dbname=${DATABASE_NAME}`,
        '--format=custom',
        `--file=${dump}`,
        '--no-password',
      ],
      { env: { ...process.env, PGPASSWORD: cluster.secrets.pgSuperuserPassword } },
    );
    expect(result.code, result.stderr).toBe(0);
  }, 240_000);

  afterAll(async () => {
    await cluster.stop();
  }, 120_000);

  it('gives the restored database the owner and the grants of the live one, and leaves no role behind', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    const restored = await pgRestore(scratch, dump);
    expect(restored.code, restored.stderr).toBe(0);
    expect(await cluster.cluster.inspectRestoreScratch(scratch)).toEqual([]);
    expect(await cluster.cluster.sealRestoreScratch(scratch)).toEqual([]);

    // The same privileges, exactly, on every object: the live database is the reference.
    const sealed = JSON.stringify((await cluster.cluster.aclFacts(SCRATCH)).map(aclKey).sort());
    expect(sealed).toBe(await live());
    expect(await restoreRoles()).toEqual([]);
    // And it works for the roles that use it: the runtime role reads, the sealer seals, nobody else does more.
    const rw = await cluster.connect('app_rw', cluster.secrets.appRwPassword, SCRATCH);
    try {
      const rows = await rw.query<{ n: number }>('SELECT count(*)::int AS n FROM patient');
      expect(rows.rows[0]?.n).toBe(2);
      await expect(rw.query("UPDATE audit_event SET body = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(rw.query('SELECT app.set_flags(gen_random_uuid())')).resolves.toBeDefined();
    } finally {
      await rw.end();
    }
    const sealer = await cluster.connect(
      'audit_sealer',
      cluster.secrets.auditSealerPassword,
      SCRATCH,
    );
    try {
      await expect(sealer.query('UPDATE audit_event SET seq = 1')).resolves.toBeDefined();
      await expect(sealer.query("UPDATE audit_event SET body = 'x'")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await sealer.end();
    }
    await cluster.cluster.dropDatabase(SCRATCH);
  }, 120_000);

  it('cannot change a role of the live cluster, and what it can change dies with it', async () => {
    const before = await roles();
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    const failures = await asRestorer(scratch, [
      'GRANT audit_sealer TO app_rw GRANTED BY app_owner',
      'GRANT audit_sealer TO app_rw',
      "ALTER ROLE app_owner PASSWORD 'hostile'",
      'ALTER ROLE app_owner SET search_path = evil',
      'ALTER ROLE app_rw SET search_path = evil',
      'CREATE ROLE hostile LOGIN',
      'SET ROLE app_owner',
      "ALTER SYSTEM SET log_statement = 'all'",
      'REVOKE audit_sealer FROM app_owner',
      // What it may do to itself:
      'ALTER ROLE CURRENT_USER SET search_path = evil',
      "ALTER ROLE CURRENT_USER PASSWORD 'its own'",
    ]);

    // Every attempt on a live role was refused by PostgreSQL itself, and the two on itself were allowed.
    expect(failures).toHaveLength(9);
    expect(failures.join('\n')).not.toMatch(/CURRENT_USER/);
    expect(await roles()).toBe(before);
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
    expect(await restoreRoles()).toEqual([]);
    expect(await roles()).toBe(before);
  }, 120_000);

  it('reads a hand-made archive like any other, so a hostile backup can be one', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    const result = await hostileRestore(scratch, ['CREATE TABLE public.made_by_hand (a int)']);

    expect(result.code, result.stderr).toBe(0);
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
  }, 120_000);

  it('cannot reach the roles of the cluster through pg_restore itself, and a failure after that changes nothing', async () => {
    const before = await roles();
    const beforeAcl = await live();
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    // One statement per entry: the first that PostgreSQL refuses ends the restore (--exit-on-error), and the whole
    // transaction goes with it. Each hostile statement is also tried alone, where the restore would otherwise have
    // committed whatever came before it.
    for (const statement of [
      'GRANT audit_sealer TO app_rw GRANTED BY app_owner',
      "ALTER ROLE app_owner PASSWORD 'hostile'",
      'ALTER ROLE app_rw SET search_path = evil',
      'ALTER ROLE app_owner SET search_path = evil',
    ]) {
      const result = await hostileRestore(scratch, ['CREATE TABLE public.ok (a int)', statement]);
      expect(result.code, statement).not.toBe(0);
      expect(result.stderr, statement).toMatch(/permission denied|must have|must be/i);
    }
    // And a restore that gets as far as it can before a trailing bad entry.
    const failing = await hostileRestore(scratch, [
      'ALTER ROLE CURRENT_USER SET search_path = evil',
      "ALTER ROLE CURRENT_USER PASSWORD 'its own'",
      'CREATE TABLE public.ok2 (a int)',
      'SELECT 1/0',
    ]);
    expect(failing.code).not.toBe(0);

    // The start after it (or the catch of the restore) drops the database and then the role.
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
    expect(await restoreRoles()).toEqual([]);
    expect(await roles()).toBe(before);
    expect(await live()).toBe(beforeAcl);
  }, 120_000);

  it('refuses, and leaves the roles as they were, a hostile backup that restores without an error', async () => {
    const before = await roles();
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    const result = await hostileRestore(scratch, [
      'CREATE TABLE public.patient (id int)',
      'GRANT ALL ON public.patient TO app_operator',
      `ALTER DATABASE ${SCRATCH} SET search_path = evil`,
      'ALTER ROLE CURRENT_USER SET search_path = evil',
      'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO app_operator',
    ]);

    expect(result.code, result.stderr).toBe(0);
    const problems = await cluster.cluster.inspectRestoreScratch(scratch);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('app_operator');
    expect(problems.join('\n')).toContain('search_path');
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
    expect(await roles()).toBe(before);
  }, 120_000);

  it('is found out when the dump changes the database itself, even though PostgreSQL allows it', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);

    const failures = await asRestorer(scratch, [
      'CREATE TABLE public.patient (id int)',
      'GRANT SELECT ON patient TO app_operator',
      `ALTER DATABASE ${SCRATCH} SET search_path = evil`,
      'GRANT USAGE ON SCHEMA public TO app_operator',
      'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO app_operator',
      'REVOKE USAGE ON SCHEMA public FROM PUBLIC',
    ]);

    expect(failures).toEqual([]);
    const problems = await cluster.cluster.inspectRestoreScratch(scratch);
    expect(problems.join('\n')).toContain('app_operator');
    expect(problems.join('\n')).toContain('the database sets parameters');
    expect(problems.some((problem) => problem.startsWith('a privilege went'))).toBe(true);
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
  }, 120_000);

  it('finds out when the dump changes what the server says about the database itself: connection limit and template', async () => {
    for (const statement of [
      `ALTER DATABASE ${SCRATCH} WITH CONNECTION LIMIT 0`,
      `ALTER DATABASE ${SCRATCH} WITH IS_TEMPLATE true`,
    ]) {
      const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
      // The role of the dump owns the database, so PostgreSQL lets it.
      const failures = await asRestorer(scratch, [statement]);
      expect(failures).toEqual([]);

      const problems = await cluster.cluster.inspectRestoreScratch(scratch);

      expect(problems.join('\n'), statement).toMatch(/connection|template|connections|limit/i);
      await cluster.cluster.dropDatabase(SCRATCH);
      await cluster.cluster.dropRestoreRoles();
    }
  }, 120_000);

  it('puts the flags of the database as a new one has them when it hands it over, whatever the dump set', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
    const restored = await pgRestore(scratch, dump);
    expect(restored.code, restored.stderr).toBe(0);
    // Set by the owner, after the inspection: the hand over does not take them on trust.
    await cluster.asSuperuser(
      'postgres',
      `ALTER DATABASE ${SCRATCH} WITH CONNECTION LIMIT 1 IS_TEMPLATE true`,
    );

    await cluster.cluster.sealRestoreScratch(scratch);

    const flags = await cluster.cluster.asSuperuser('postgres', async (client) => {
      const found = await client.query(
        `SELECT datistemplate AS t, datallowconn AS c, datconnlimit AS l FROM pg_catalog.pg_database WHERE datname = $1`,
        [SCRATCH],
      );
      const row = found.rows[0] as { t: boolean; c: boolean; l: number } | undefined;
      return row ? { t: row.t, c: row.c, l: row.l } : undefined;
    });
    expect(flags).toEqual({ t: false, c: true, l: -1 });
    await cluster.cluster.dropDatabase(SCRATCH);
  }, 120_000);

  it('hands over a database whose hostile grants are gone, and gives the live ones back', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
    const restored = await pgRestore(scratch, dump);
    expect(restored.code, restored.stderr).toBe(0);
    // The restore went well; then a hostile grant is found in what it left (as inspect does)...
    await asRestorer(scratch, ['GRANT ALL ON public.patient TO app_operator']);
    expect((await cluster.cluster.inspectRestoreScratch(scratch)).join('\n')).toContain(
      'app_operator',
    );
    // ...and had it been sealed anyway, the final comparison with the live database would not let it through.
    const problems = await cluster.cluster.sealRestoreScratch(scratch);

    expect(problems.join('\n')).toContain('app_operator');
    await cluster.cluster.dropDatabase(SCRATCH);
  }, 120_000);

  it('runs no code of the dump when it takes the database over, whatever the dump defines', async () => {
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
    const restored = await pgRestore(scratch, dump);
    expect(restored.code, restored.stderr).toBe(0);
    const failures = await asRestorer(scratch, [
      "CREATE FUNCTION public.boom() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
      "CREATE FUNCTION public.boom_immutable(int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
      'CREATE TABLE public.trap (a int DEFAULT public.boom(), b int GENERATED ALWAYS AS (public.boom_immutable(a)) STORED, CHECK (public.boom_immutable(a) > 0))',
      'CREATE INDEX trap_index ON public.trap (public.boom_immutable(a))',
      'CREATE VIEW public.trap_view AS SELECT public.boom() AS x',
      'CREATE POLICY trap_policy ON public.patient USING (public.boom() > 0)',
      "CREATE FUNCTION public.trap_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
      'CREATE TRIGGER trap_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.trap FOR EACH ROW EXECUTE FUNCTION public.trap_trigger()',
      // The operator that wins over the built-in one for these arguments (the pattern of CVE-2018-1058), and a
      // function that wins over `has_table_privilege` for the same reason.
      "CREATE FUNCTION public.shadow_concat(name, text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
      'CREATE OPERATOR public.|| (LEFTARG = name, RIGHTARG = text, FUNCTION = public.shadow_concat)',
      "CREATE FUNCTION public.has_table_privilege(name, oid, text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
      "CREATE FUNCTION public.aclexplode(aclitem[]) RETURNS SETOF record LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hostile code ran'; END $$",
    ]);
    expect(failures).toEqual([]);

    expect(await cluster.cluster.inspectRestoreScratch(scratch)).toEqual([]);
    const problems = await cluster.cluster.sealRestoreScratch(scratch);
    expect(problems).toEqual([]);
    // What reads the database afterwards, as the owner and as the superuser, does not run it either.
    await expect(cluster.cluster.scratchFacts(SCRATCH)).resolves.toBeDefined();
    await expect(cluster.cluster.clusterFacts(SCRATCH)).resolves.toBeDefined();
    await expect(cluster.cluster.aclFacts(SCRATCH)).resolves.toBeDefined();
    await cluster.cluster.dropDatabase(SCRATCH);
  }, 120_000);

  it('leaves nothing behind when it is cut off at any point: the next start drops the database, then the role', async () => {
    const before = await roles();
    const beforeAcl = await live();
    const first = await cluster.cluster.createRestoreScratch(SCRATCH);
    await asRestorer(first, [
      'ALTER ROLE CURRENT_USER SET search_path = evil',
      'CREATE TABLE t (a int)',
    ]);
    // The process died: nothing was sealed. A new restore (or the next start) cleans up after it.
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();

    expect(await restoreRoles()).toEqual([]);
    expect(await roles()).toBe(before);
    expect(await live()).toBe(beforeAcl);

    // Even without the database being dropped first, the next restore starts clean.
    const second = await cluster.cluster.createRestoreScratch(SCRATCH);
    const third = await cluster.cluster.createRestoreScratch(SCRATCH);
    expect(await restoreRoles()).toEqual([third.user]);
    expect(second.user).not.toBe(third.user);
    await cluster.cluster.dropDatabase(SCRATCH);
    await cluster.cluster.dropRestoreRoles();
  }, 120_000);

  it('finds a trigger, a rule or a policy on the tables of the migrator before anything migrates the database', async () => {
    const hooks = [
      'CREATE TRIGGER hook BEFORE INSERT ON drizzle.__drizzle_migrations FOR EACH ROW EXECUTE FUNCTION public.hook()',
      'CREATE RULE hook AS ON INSERT TO drizzle.__drizzle_migrations DO ALSO NOTIFY hooked',
      'CREATE POLICY hook ON drizzle.__drizzle_migrations USING (true)',
    ];
    for (const hook of hooks) {
      const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
      const failures = await asRestorer(scratch, [
        'CREATE SCHEMA drizzle',
        'CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
        'CREATE FUNCTION public.hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
        hook,
      ]);
      expect(failures).toEqual([]);

      const problems = await cluster.cluster.inspectRestoreScratch(scratch);
      const facts = await cluster.cluster.scratchFacts(SCRATCH);

      expect(problems.join(' | '), hook).toContain('hooks');
      expect(facts.drizzleHooks, hook).toHaveLength(1);
      await cluster.cluster.dropDatabase(SCRATCH);
      await cluster.cluster.dropRestoreRoles();
    }
  }, 120_000);

  it('sees what a hook of the dump does when the migrations touch the database, and puts the roles back', async () => {
    const before = await cluster.cluster.clusterFacts(DATABASE_NAME);
    const scratch = await cluster.cluster.createRestoreScratch(SCRATCH);
    const restored = await pgRestore(scratch, dump);
    expect(restored.code, restored.stderr).toBe(0);
    const failures = await asRestorer(scratch, [
      `CREATE FUNCTION public.hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'ALTER ROLE app_owner SET search_path = evil'; EXECUTE 'ALTER DATABASE ${SCRATCH} SET work_mem = 65536'; RETURN NEW; END $$`,
      'CREATE TRIGGER hook BEFORE INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.hook()',
    ]);
    expect(failures).toEqual([]);
    // Nothing of that is on the tables of the migrator, so the inspection has no objection...
    expect(await cluster.cluster.inspectRestoreScratch(scratch)).toEqual([]);
    expect(await cluster.cluster.sealRestoreScratch(scratch)).toEqual([]);

    // ...and a migration that writes to the table runs it, as app_owner, with the rights of app_owner.
    const owner = await cluster.connect('app_owner', cluster.secrets.appOwnerPassword, SCRATCH);
    try {
      await owner.query("INSERT INTO public.audit_event (body) VALUES ('nobody')");
    } finally {
      await owner.end();
    }
    const after = await cluster.cluster.clusterFacts(SCRATCH);
    const problems = auditProblems(before, after, await cluster.cluster.scratchFacts(SCRATCH));

    expect(problems.join(' | ')).toContain('a role sets a parameter');
    expect(problems.join(' | ')).toContain('the database sets parameters');
    await cluster.cluster.executeStatements(
      revertStatements(
        before,
        await cluster.cluster.clusterFacts(null),
        cluster.secrets.appOwnerPassword,
      ),
    );
    expect(await roles()).toBe(JSON.stringify(before));
    await cluster.cluster.dropDatabase(SCRATCH);
  }, 120_000);

  it('only lets app_owner hand out audit_sealer while a migration needs it', async () => {
    const admin = async () =>
      cluster.cluster.asSuperuser('postgres', async (client) => {
        const found = await client.query(
          `SELECT am.admin_option AS admin FROM pg_catalog.pg_auth_members am
             JOIN pg_catalog.pg_roles r ON r.oid = am.roleid JOIN pg_catalog.pg_roles m ON m.oid = am.member
            WHERE r.rolname = 'audit_sealer' AND m.rolname = 'app_owner'`,
        );
        return found.rows[0]?.['admin'] === true;
      });
    expect(await admin()).toBe(true);

    await cluster.cluster.setOwnerAuditAdmin(false);
    expect(await admin()).toBe(false);
    // Without it a statement of a dump cannot hand the role out through app_owner...
    const owner = await cluster.connect(
      'app_owner',
      cluster.secrets.appOwnerPassword,
      DATABASE_NAME,
    );
    try {
      await expect(owner.query('GRANT audit_sealer TO app_rw')).rejects.toThrow();
    } finally {
      await owner.end();
    }
    // ...and a migration gets it back for the time it runs.
    await cluster.cluster.setOwnerAuditAdmin(true);
    expect(await admin()).toBe(true);
    await cluster.cluster.setOwnerAuditAdmin(false);
  }, 60_000);
});
