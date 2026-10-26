import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  MISSING_OBJECT_CODES,
  aclChanges,
  aclExtras,
  trustedGrants,
  type AclEntry,
} from './restore-acl.js';
import type { ClusterFacts, ScratchFacts } from './restore-audit.js';
import { rotateBySize } from './rotating-log.js';
import type { Runner } from './runner.js';

/** The database of the product, and the superuser `initdb` creates. */
export const DATABASE_NAME = 'consultorio';
export const SUPERUSER = 'postgres';
/** The design fixes this once: the worst case of every pool (see docs/desktop/design.md). */
export const MAX_CONNECTIONS = 200;

/** The part of a `pg` client the shell uses. */
export interface SqlClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface ConnectionTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Startup options of the session, such as `-c search_path=...`. */
  options?: string;
}

export interface PostgresOptions {
  /** The folder with `initdb.exe`, `pg_ctl.exe` and `postgres.exe`. */
  binDir: string;
  pgdata: string;
  /** Where PostgreSQL writes its own log. */
  logFile: string;
  superuserPassword: string;
  /**
   * The password of `app_owner`. Anything that reads a database that a backup may have written is done as this
   * role and not as the superuser: SQL that is inside a restored database (a view, a function, a trigger) runs
   * with the power of whoever reads it.
   */
  ownerPassword: string;
  runner: Runner;
  connect: (target: ConnectionTarget) => SqlClient;
  freePort: () => Promise<number>;
  /** True when the process with this id is a `postgres.exe`. */
  isPostgresProcess: (pid: number) => Promise<boolean>;
  /** A folder for the password file of `initdb`, which exists for a moment. */
  scratchDir: string;
  log?: (message: string) => void;
  /** Waits between two looks at a server that is starting. Tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How often a server that is starting is looked at, in milliseconds. */
  pollMs?: number;
  /** How long a server that is still starting is waited for before it is stopped. */
  startupWaitMs?: number;
}

export class PostgresError extends Error {
  constructor(
    message: string,
    /** The tail of the program's output, for the log. Never contains a password. */
    readonly detail = '',
  ) {
    super(message);
    this.name = 'PostgresError';
  }
}

/**
 * What the server writes to its log. The default would put the text of a failed statement, and the row an
 * error is about, in a file that is sent to support: patient data. Terse errors, no statements, no
 * connection lines.
 */
const QUIET_LOGGING =
  '-c log_error_verbosity=terse -c log_min_error_statement=panic -c log_connections=off -c log_disconnections=off';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;

const tail = (text: string, lines = 12) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

/**
 * The PostgreSQL cluster of the install: created once, started on a free loopback port on every run
 * and stopped with `pg_ctl stop -m fast` on quit. Everything goes through `pg_ctl`, never a kill: a
 * server killed in the middle of a write recovers on the next start, but it should not have to.
 */
export class PostgresCluster {
  private port: number | null = null;

  constructor(private readonly options: PostgresOptions) {}

  private log(message: string): void {
    this.options.log?.(message);
  }

  private bin(name: string): string {
    return join(this.options.binDir, `${name}.exe`);
  }

  get runningPort(): number | null {
    return this.port;
  }

  isInitialized(): boolean {
    return existsSync(join(this.options.pgdata, 'PG_VERSION'));
  }

  /** `initdb` with UTF-8, the superuser password from a file that exists only while it runs. */
  async initCluster(): Promise<void> {
    const { pgdata, scratchDir, superuserPassword, runner } = this.options;
    mkdirSync(dirname(pgdata), { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
    const passwordFile = join(scratchDir, `initdb-${String(process.pid)}.pw`);
    writeFileSync(passwordFile, superuserPassword, { mode: 0o600 });
    try {
      const result = await runner(
        this.bin('initdb'),
        [
          '-D',
          pgdata,
          '-U',
          SUPERUSER,
          '-A',
          'scram-sha-256',
          `--pwfile=${passwordFile}`,
          '-E',
          'UTF8',
          // Windows' own collation: accents and capitals sort and compare the way Spanish speakers expect.
          '--locale=en-US',
          '-c',
          `max_connections=${String(MAX_CONNECTIONS)}`,
          '-c',
          'listen_addresses=127.0.0.1',
          '-c',
          'lc_messages=C',
        ],
        { timeoutMs: 5 * 60_000 },
      );
      if (result.code !== 0) {
        throw new PostgresError('initdb failed', tail(result.stderr || result.stdout));
      }
    } finally {
      rmSync(passwordFile, { force: true });
    }
    this.log('database cluster created');
  }

  /**
   * Makes the data folder startable. A `postmaster.pid` left by a crash is either dead, and removed, or a
   * server that is still alive (the shell was killed and the server was not, or a start took longer than the
   * shell waited and the person pressed Retry). A server that is up and answering is kept and its port is
   * returned; one that is still starting is waited for, one that is stopping is waited out, and one that never
   * gets ready is stopped cleanly. Returns the port of a server that was kept, else `null`.
   */
  async recoverStalePid(): Promise<number | null> {
    const pidFile = join(this.options.pgdata, 'postmaster.pid');
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
    if (!(Number.isInteger(pid) && pid > 0 && (await this.options.isPostgresProcess(pid)))) {
      rmSync(pidFile, { force: true });
      this.log('removed a stale postmaster.pid');
      return null;
    }
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.options.pollMs ?? 500;
    const polls = Math.max(1, Math.ceil((this.options.startupWaitMs ?? 90_000) / pollMs));
    for (let poll = 0; poll < polls; poll += 1) {
      const info = this.readPidFile(pidFile);
      // It went away while we looked: nothing is running any more.
      if (info === null) return null;
      if (info.status === 'ready' && info.port > 0) {
        if (await this.answers(info.port)) {
          this.log(`a server (pid ${String(pid)}) is up on port ${String(info.port)}; keeping it`);
          this.port = info.port;
          return info.port;
        }
      } else if (info.status !== 'starting' && info.status !== 'stopping') {
        break;
      }
      await sleep(pollMs);
    }
    if (existsSync(pidFile)) {
      this.log(`a previous server (pid ${String(pid)}) is still running; stopping it`);
      await this.stop();
    }
    return null;
  }

  private readPidFile(pidFile: string): { port: number; status: string } | null {
    try {
      const lines = readFileSync(pidFile, 'utf8').split(/\r?\n/);
      return { port: Number(lines[3]), status: (lines[7] ?? '').trim() };
    } catch {
      return null;
    }
  }

  /** True when a server on this port accepts the login of the superuser. */
  private async answers(port: number): Promise<boolean> {
    const client = this.options.connect({
      host: '127.0.0.1',
      port,
      user: SUPERUSER,
      password: this.options.superuserPassword,
      database: 'postgres',
    });
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * How many migrations the database of the product has had applied (the rows of the table the migrator keeps),
   * or `null` when it has none: a database that is new.
   */
  async appliedMigrationCount(): Promise<number | null> {
    try {
      // As `app_owner`, who ran the migrations: a restored database can make this table a view whose function
      // runs as whoever reads it, and the superuser must never be the one.
      return await this.asOwner(DATABASE_NAME, async (client) => {
        const found = await client.query(
          'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
        );
        return Number(found.rows[0]?.['n'] ?? 0);
      });
    } catch (error) {
      // The table or its schema is not there: nothing was ever migrated.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '42P01' || code === '3F000') return null;
      throw error;
    }
  }

  /** True when the server answers a query now; never throws. */
  async ping(): Promise<boolean> {
    if (this.port === null) return false;
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 5_000).unref();
    });
    const query = this.asSuperuser('postgres', async (client) => {
      await client.query('SELECT 1');
      return true;
    }).catch(() => false);
    return Promise.race([query, timeout]);
  }

  /** Starts the server on a free loopback port and returns the port. */
  async start(): Promise<number> {
    const { pgdata, logFile, runner } = this.options;
    const kept = await this.recoverStalePid();
    if (kept !== null) return kept;
    mkdirSync(dirname(logFile), { recursive: true });
    // PostgreSQL appends to this file for as long as it runs: it is capped here, before it opens it.
    rotateBySize(logFile, { maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP });
    const port = await this.options.freePort();
    const result = await runner(
      this.bin('pg_ctl'),
      [
        'start',
        '-D',
        pgdata,
        '-l',
        logFile,
        '-w',
        '-t',
        '90',
        '-o',
        `-p ${String(port)} -c listen_addresses=127.0.0.1 -c max_connections=${String(MAX_CONNECTIONS)} ${QUIET_LOGGING}`,
      ],
      { leavesChildren: true, timeoutMs: 120_000 },
    );
    if (result.code !== 0) {
      throw new PostgresError(
        'the database server did not start',
        tail(result.stdout + result.stderr),
      );
    }
    this.port = port;
    this.log(`database server started on port ${String(port)}`);
    return port;
  }

  /** `pg_ctl stop -m fast`: ends the sessions, writes a checkpoint, exits. */
  async stop(): Promise<void> {
    const { pgdata, runner } = this.options;
    if (!existsSync(join(pgdata, 'postmaster.pid'))) {
      this.port = null;
      return;
    }
    const result = await runner(
      this.bin('pg_ctl'),
      ['stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '60'],
      { leavesChildren: true, timeoutMs: 90_000 },
    );
    if (result.code !== 0) {
      throw new PostgresError(
        'the database server did not stop',
        tail(result.stdout + result.stderr),
      );
    }
    this.port = null;
    this.log('database server stopped');
  }

  /**
   * Runs `work` with a connection of the superuser to `database`. The session searches `pg_catalog` and nothing
   * else: a database that a backup wrote can define an operator or a function in `public` that wins over the
   * built-in one for the arguments it is given (the pattern of CVE-2018-1058), and a query of ours would run it as
   * the superuser. `searchPath: false` is for the script that creates the roles, which is ours.
   */
  async asSuperuser<T>(
    database: string,
    work: (client: SqlClient) => Promise<T>,
    searchPath = true,
  ): Promise<T> {
    return this.asRole(SUPERUSER, this.options.superuserPassword, database, work, searchPath);
  }

  /** Runs `work` with a connection of `app_owner` to `database`: for reading what a backup may have written. */
  async asOwner<T>(database: string, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.asRole(OWNER, this.options.ownerPassword, database, work, true);
  }

  private async asRole<T>(
    user: string,
    password: string,
    database: string,
    work: (client: SqlClient) => Promise<T>,
    safeSearchPath: boolean,
  ): Promise<T> {
    if (this.port === null) throw new PostgresError('the database server is not running');
    const client = this.options.connect({
      host: '127.0.0.1',
      port: this.port,
      user,
      password,
      database,
      ...(safeSearchPath ? { options: SAFE_SEARCH_PATH } : {}),
    });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Creates the database of the product when it is not there. */
  async ensureDatabase(): Promise<void> {
    await this.asSuperuser('postgres', async (client) => {
      const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        DATABASE_NAME,
      ]);
      if (found.rows.length === 0) {
        await client.query(`CREATE DATABASE ${DATABASE_NAME} ENCODING 'UTF8'`);
      }
    });
  }

  /**
   * The place a restore is made in: an empty database that belongs to a throwaway role, made for this restore alone.
   *
   * `pg_restore` runs SQL that a backup wrote. Run as `app_owner` (which can grant `audit_sealer`, change its own
   * password and set parameters of its role), a restore that committed left cluster-wide effects that outlived the
   * scratch database, and every check that tried to find them was one more thing to get wrong. So the dump is run
   * as a role that can do nothing outside its own database: no memberships, no admin option, not a superuser, no
   * right to create roles or databases. It owns the scratch database, and whatever it does to itself dies with it
   * (`sealRestoreScratch` drops it). Any role of an earlier restore that was cut off is dropped first.
   *
   * What the live database grants, and what the new database starts with, are read here: they are the references
   * the restored database is compared with and given its grants from (see `restore-acl.ts`).
   */
  async createRestoreScratch(name: string): Promise<RestoreScratch> {
    assertDatabaseName(name);
    const user = `${RESTORE_ROLE_PREFIX}${randomBytes(6).toString('hex')}`;
    const password = randomBytes(24).toString('base64url');
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await dropRestoreRolesWith(client);
      await client.query(
        `CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 8`,
      );
      await client.query(
        `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' OWNER ${user}`,
      );
    });
    const live = await this.aclFacts(DATABASE_NAME);
    const baseline = await this.aclFacts(name);
    return { database: name, user, password, live, baseline };
  }

  /**
   * What the restore did besides loading rows: nothing may have changed a privilege or a parameter of the database.
   * A backup made by this program has none of that to say (the dump is restored with `--no-privileges`), so any
   * difference from the state the database started in was written by SQL hidden in the dump. Empty is clean.
   */
  async inspectRestoreScratch(scratch: RestoreScratch): Promise<string[]> {
    const after = await this.aclFacts(scratch.database);
    const problems = aclChanges(scratch.baseline, after);
    const settings = await this.databaseSettings(scratch.database);
    if (settings.length > 0)
      problems.push(`the database sets parameters: ${JSON.stringify(settings)}`);
    return problems;
  }

  /**
   * Hands the restored database over to `app_owner` and removes the throwaway role, as the superuser. Every
   * statement is DDL that runs no code of the dump: `REASSIGN OWNED` and `DROP OWNED` change owners and ACL
   * entries in the catalogs, `ALTER DATABASE ... RESET ALL` deletes rows of `pg_db_role_setting`, and `GRANT` and
   * `REVOKE` set ACLs; none evaluates an expression, calls a function or fires a trigger (event triggers need a
   * superuser to be created, so the dump cannot have made one). The grants come from the live database
   * (`trustedGrants`). Returns what is still wrong: empty is clean.
   */
  async sealRestoreScratch(scratch: RestoreScratch): Promise<string[]> {
    assertDatabaseName(scratch.database);
    assertRestoreRole(scratch.user);
    const grants = trustedGrants(scratch.live, scratch.database);
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`ALTER DATABASE ${scratch.database} OWNER TO ${OWNER}`);
      await client.query(`ALTER DATABASE ${scratch.database} RESET ALL`);
      await client.query(`ALTER ROLE ALL IN DATABASE ${scratch.database} RESET ALL`);
      for (const statement of grants.database) await client.query(statement);
    });
    await this.asSuperuser(scratch.database, async (client) => {
      await client.query(`REASSIGN OWNED BY ${scratch.user} TO ${OWNER}`);
      for (const statement of grants.inside) {
        try {
          await client.query(statement);
        } catch (error) {
          // The backup is older than the live database and does not have that object: its grants come with the
          // migrations that create it.
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code !== 'string' || !MISSING_OBJECT_CODES.has(code)) throw error;
        }
      }
      await client.query(`DROP OWNED BY ${scratch.user}`);
    });
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`DROP ROLE ${scratch.user}`);
    });
    const after = await this.aclFacts(scratch.database);
    const problems = aclExtras(after, scratch.live, scratch.baseline);
    const owners = await this.asSuperuser(scratch.database, async (client) => {
      const found = await client.query(FOREIGN_OWNERS_SQL, [OWNER]);
      return found.rows.map(
        (row) =>
          `an object of the backup is owned by ${JSON.stringify([row['kind'], row['schema'], row['name'], row['owner']])}`,
      );
    });
    return [...problems, ...owners];
  }

  /** Drops every throwaway role of a restore that was cut off. Its database must be gone first. */
  async dropRestoreRoles(): Promise<void> {
    await this.asSuperuser('postgres', (client) => dropRestoreRolesWith(client));
  }

  private async databaseSettings(name: string): Promise<string[]> {
    return this.asSuperuser('postgres', async (client) => {
      const found = await client.query(
        `SELECT s.setting
           FROM pg_catalog.pg_db_role_setting d
           JOIN pg_catalog.pg_database db ON db.oid = d.setdatabase
           CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS s(setting)
          WHERE db.datname = $1`,
        [name],
      );
      return found.rows.map((row) => String(row['setting']));
    });
  }

  /** Every privilege that is granted on anything of `database`, read as the superuser with a search path of `pg_catalog`. */
  async aclFacts(database: string): Promise<AclEntry[]> {
    assertDatabaseName(database);
    const entries: AclEntry[] = [];
    await this.asSuperuser(database, async (client) => {
      for (const [kind, sql] of ACL_QUERIES) {
        const found = await client.query(sql, kind === 'database' ? [database] : []);
        for (const row of found.rows) {
          entries.push({
            kind,
            schema: String(row['schema']),
            name: String(row['name']),
            args: String(row['args']),
            column: String(row['col']),
            objtype: String(row['objtype']),
            owner: String(row['owner']),
            grantee: String(row['grantee']),
            privilege: String(row['privilege']),
            grantable: row['grantable'] === true,
          });
        }
      }
    });
    return entries;
  }

  /**
   * Whether `app_owner` may hand out `audit_sealer`. Only the migrations need it (migration 0020 takes the
   * membership `app_rw` was given at the bootstrap away), so it is given before a migration runs and taken away
   * after: an `app_owner` that is a member with the admin option is what a hostile statement could use.
   */
  async setOwnerAuditAdmin(allowed: boolean): Promise<void> {
    await this.asSuperuser('postgres', async (client) => {
      if (allowed) {
        await client.query(
          `GRANT audit_sealer TO ${OWNER} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
        );
      } else {
        await client.query(`REVOKE ADMIN OPTION FOR audit_sealer FROM ${OWNER} CASCADE`);
      }
    });
  }

  /**
   * Makes `scratch` the database of the product and keeps the old one aside until the swap is done. Nothing
   * may be connected to either: the API and the worker are stopped. If the second rename fails the first
   * is undone, so the product database always exists.
   */
  async swapInDatabase(scratch: string): Promise<void> {
    assertDatabaseName(scratch);
    const aside = `${DATABASE_NAME}_before_restore`;
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${aside} WITH (FORCE)`);
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${DATABASE_NAME}', '${scratch}') AND pid <> pg_backend_pid()`,
      );
      await client.query(`ALTER DATABASE ${DATABASE_NAME} RENAME TO ${aside}`);
      try {
        await client.query(`ALTER DATABASE ${scratch} RENAME TO ${DATABASE_NAME}`);
      } catch (error) {
        // If even this fails the start after it puts the name right (see `reconcileInterruptedRestore`).
        await client
          .query(`ALTER DATABASE ${aside} RENAME TO ${DATABASE_NAME}`)
          .catch(() => undefined);
        throw error;
      }
      // The restored database is the real one now. The old one is garbage: failing to drop it must not make a
      // restore that worked look like one that did not, and the next start drops it.
      await client.query(`DROP DATABASE ${aside} WITH (FORCE)`).catch(() => undefined);
    });
  }

  /**
   * What a restore must leave as it was: memberships among the roles of the application, their parameters, the
   * password of `app_owner`, and (when `auditDatabase` is given) what the application roles may do to the audit
   * trail in that database. The cluster-wide part is read in the `postgres` database, as the superuser; the
   * part inside a database is read as `app_owner`.
   */
  async clusterFacts(auditDatabase: string | null): Promise<ClusterFacts> {
    const roles = [...APPLICATION_ROLES];
    const facts = await this.asSuperuser('postgres', async (client) => {
      const memberships = await client.query(
        `SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor,
                am.admin_option AS admin, am.inherit_option AS inherit, am.set_option AS "set"
           FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.roleid
           JOIN pg_roles m ON m.oid = am.member
           JOIN pg_roles g ON g.oid = am.grantor
          WHERE r.rolname = ANY($1) OR m.rolname = ANY($1)
          ORDER BY 1, 2, 3`,
        [roles],
      );
      const settings = await client.query(
        `SELECT r.rolname AS role, s.setting
           FROM pg_db_role_setting d
           JOIN pg_roles r ON r.oid = d.setrole
           CROSS JOIN LATERAL unnest(d.setconfig) AS s(setting)
          WHERE r.rolname = ANY($1)`,
        [roles],
      );
      const password = await client.query(
        `SELECT rolpassword AS hash FROM pg_authid WHERE rolname = 'app_owner'`,
      );
      return {
        memberships: memberships.rows.map((row) => ({
          role: String(row['role']),
          member: String(row['member']),
          grantor: String(row['grantor']),
          admin: row['admin'] === true,
          inherit: row['inherit'] === true,
          set: row['set'] === true,
        })),
        roleSettings: settings.rows.map(
          (row) => `${String(row['role'])}=${String(row['setting'])}`,
        ),
        ownerPasswordHash:
          typeof password.rows[0]?.['hash'] === 'string' ? password.rows[0]['hash'] : '',
      };
    });
    const auditPrivileges =
      auditDatabase === null
        ? []
        : await this.asOwner(auditDatabase, async (client) => {
            const found = await client.query(AUDIT_PRIVILEGES_SQL);
            return found.rows.map((row) => ({
              role: String(row['role']),
              privilege: String(row['privilege']),
              table: String(row['table_name']),
            }));
          });
    return { ...facts, auditPrivileges };
  }

  /** What is true of a scratch database that a backup was restored into. */
  async scratchFacts(name: string): Promise<ScratchFacts> {
    assertDatabaseName(name);
    const databaseSettings = await this.databaseSettings(name);
    const migrationsKind = await this.asOwner(name, async (client) => {
      const found = await client.query(
        `SELECT c.relkind AS kind
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'`,
      );
      const kind = found.rows[0]?.['kind'];
      return typeof kind === 'string' ? kind : null;
    });
    return { migrationsKind, databaseSettings };
  }

  /** Runs statements built by `revertStatements`, as the superuser, in the `postgres` database. */
  async executeStatements(statements: readonly string[]): Promise<void> {
    if (statements.length === 0) return;
    await this.asSuperuser('postgres', async (client) => {
      for (const statement of statements) await client.query(statement);
    });
  }

  /** The names of the databases of the server. */
  async listDatabases(): Promise<string[]> {
    return this.asSuperuser('postgres', async (client) => {
      const found = await client.query('SELECT datname FROM pg_database');
      return found.rows.map((row) => String(row['datname']));
    });
  }

  /** Renames a database, forcing out whoever is connected (a restore that was cut off is put right with it). */
  async renameDatabase(from: string, to: string): Promise<void> {
    assertDatabaseName(from);
    assertDatabaseName(to);
    await this.asSuperuser('postgres', async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid()`,
      );
      await client.query(`ALTER DATABASE ${from} RENAME TO ${to}`);
    });
  }

  /** Drops a database, forcing out whoever is connected. */
  async dropDatabase(name: string): Promise<void> {
    assertDatabaseName(name);
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  }

  /** Runs a script (several statements) in the database of the product, as the superuser. */
  async runScript(script: string): Promise<void> {
    await this.asSuperuser(
      DATABASE_NAME,
      async (client) => {
        await client.query(script);
      },
      false,
    );
  }

  /** `postgres://<role>:<password>@127.0.0.1:<port>/consultorio` for a process of the install. */
  urlFor(role: string, password: string): string {
    if (this.port === null) throw new PostgresError('the database server is not running');
    return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${String(this.port)}/${DATABASE_NAME}`;
  }
}

/** The roles the application uses: what a restore compares before and after. */
const APPLICATION_ROLES = [
  'app_owner',
  'app_rw',
  'app_operator',
  'app_releaser',
  'audit_sealer',
] as const;

const OWNER = 'app_owner';

/** What the application roles may do to the audit trail, read inside a database: columns, never joined into text. */
const AUDIT_PRIVILEGES_SQL = `
  SELECT r.rolname AS role, p.priv AS privilege, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN (VALUES ('app_rw'), ('app_operator'), ('app_releaser')) AS r(rolname)
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE n.nspname = 'public'
     AND c.relname IN ('audit_event', 'platform_audit_event')
     AND c.relkind IN ('r', 'p')
     AND (pg_catalog.has_table_privilege(r.rolname, c.oid, p.priv)
          OR (p.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND pg_catalog.has_any_column_privilege(r.rolname, c.oid, p.priv)))
`;

/** The session of every connection to a database a backup may have written: `pg_catalog` and nothing else. */
const SAFE_SEARCH_PATH = '-c search_path=pg_catalog,pg_temp';

const RESTORE_ROLE_PREFIX = 'consulvia_restore_';

/** What a restore is made with: the throwaway role, and the privileges the databases started with. */
export interface RestoreScratch {
  database: string;
  user: string;
  password: string;
  /** What the live database grants: the trusted source of the grants of the restored one. */
  live: AclEntry[];
  /** What the new, empty database grants before the restore touches it. */
  baseline: AclEntry[];
}

function assertRestoreRole(name: string): void {
  if (!/^consulvia_restore_[0-9a-f]{12}$/.test(name))
    throw new PostgresError(`unsafe role name: ${name}`);
}

async function dropRestoreRolesWith(client: SqlClient): Promise<void> {
  const found = await client.query(
    `SELECT rolname FROM pg_catalog.pg_roles WHERE pg_catalog.starts_with(rolname, $1)`,
    [RESTORE_ROLE_PREFIX],
  );
  for (const row of found.rows) {
    const role = String(row['rolname']);
    assertRestoreRole(role);
    await client.query(
      'SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1',
      [role],
    );
    await client.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

/** Objects of a restored database that are not owned by `app_owner` (or by the owner of the database, for `public`). */
const FOREIGN_OWNERS_SQL = `
  SELECT 'relation' AS kind, n.nspname AS schema, c.relname AS name, o.rolname AS owner
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
     AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND NOT o.rolsuper AND o.rolname NOT IN ($1, 'pg_database_owner')
  UNION ALL
  SELECT 'routine', n.nspname, p.proname, o.rolname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT o.rolsuper AND o.rolname NOT IN ($1, 'pg_database_owner')
  UNION ALL
  SELECT 'schema', '', n.nspname, o.rolname
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
     AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND NOT o.rolsuper AND o.rolname NOT IN ($1, 'pg_database_owner')
`;

const NON_SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

/** The grantee as a name: `PUBLIC` for 0. */
const GRANTEE = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee`;
const EXPLODE = (acl: string) =>
  `CROSS JOIN LATERAL pg_catalog.aclexplode(${acl}) a LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee`;
const PRIVILEGE = 'a.privilege_type AS privilege, a.is_grantable AS grantable';

/** One query per class of object that has an ACL; every column is a column of the catalog. */
const ACL_QUERIES: readonly (readonly [AclEntry['kind'], string])[] = [
  [
    'database',
    `SELECT '' AS schema, '' AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid = d.datdba ${EXPLODE('d.datacl')}
      WHERE d.datname = $1`,
  ],
  [
    'schema',
    `SELECT '' AS schema, n.nspname AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner ${EXPLODE('n.nspacl')}
      WHERE ${NON_SYSTEM}`,
  ],
  [
    'relation',
    `SELECT n.nspname AS schema, c.relname AS name, '' AS args, '' AS col, c.relkind::pg_catalog.text AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_roles o ON o.oid = c.relowner ${EXPLODE('c.relacl')}
      WHERE ${NON_SYSTEM}`,
  ],
  [
    'column',
    `SELECT n.nspname AS schema, c.relname AS name, '' AS args, t.attname::pg_catalog.text AS col, c.relkind::pg_catalog.text AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid = t.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_roles o ON o.oid = c.relowner ${EXPLODE('t.attacl')}
      WHERE NOT t.attisdropped AND ${NON_SYSTEM}`,
  ],
  [
    'routine',
    `SELECT n.nspname AS schema, p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, '' AS col, p.prokind::pg_catalog.text AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid = p.proowner ${EXPLODE('p.proacl')}
      WHERE ${NON_SYSTEM}`,
  ],
  [
    'type',
    `SELECT n.nspname AS schema, t.typname AS name, '' AS args, '' AS col, t.typtype::pg_catalog.text AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_catalog.pg_roles o ON o.oid = t.typowner ${EXPLODE('t.typacl')}
      WHERE ${NON_SYSTEM}`,
  ],
  [
    'language',
    `SELECT '' AS schema, l.lanname AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_language l JOIN pg_catalog.pg_roles o ON o.oid = l.lanowner ${EXPLODE('l.lanacl')}`,
  ],
  [
    'fdw',
    `SELECT '' AS schema, w.fdwname AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_foreign_data_wrapper w JOIN pg_catalog.pg_roles o ON o.oid = w.fdwowner ${EXPLODE('w.fdwacl')}`,
  ],
  [
    'server',
    `SELECT '' AS schema, s.srvname AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_foreign_server s JOIN pg_catalog.pg_roles o ON o.oid = s.srvowner ${EXPLODE('s.srvacl')}`,
  ],
  [
    'largeobject',
    `SELECT '' AS schema, m.oid::pg_catalog.text AS name, '' AS args, '' AS col, '' AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_largeobject_metadata m JOIN pg_catalog.pg_roles o ON o.oid = m.lomowner ${EXPLODE('m.lomacl')}`,
  ],
  [
    'default',
    `SELECT COALESCE(n.nspname, '') AS schema, '' AS name, '' AS args, '' AS col, d.defaclobjtype::pg_catalog.text AS objtype, o.rolname AS owner, ${GRANTEE}, ${PRIVILEGE}
       FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles o ON o.oid = d.defaclrole
       LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace ${EXPLODE('d.defaclacl')}`,
  ],
];

/** Database names are built by the shell, never typed, but they go into SQL as identifiers all the same. */
function assertDatabaseName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name))
    throw new PostgresError(`unsafe database name: ${name}`);
}
