import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
}

export interface PostgresOptions {
  /** The folder with `initdb.exe`, `pg_ctl.exe` and `postgres.exe`. */
  binDir: string;
  pgdata: string;
  /** Where PostgreSQL writes its own log. */
  logFile: string;
  superuserPassword: string;
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

  /** Runs `work` with a connection of the superuser to `database`. */
  async asSuperuser<T>(database: string, work: (client: SqlClient) => Promise<T>): Promise<T> {
    if (this.port === null) throw new PostgresError('the database server is not running');
    const client = this.options.connect({
      host: '127.0.0.1',
      port: this.port,
      user: SUPERUSER,
      password: this.options.superuserPassword,
      database,
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
   * An empty database next to the real one, set up like `01-roles.sql` sets up the real one (owner and who
   * may connect), for a restore to fill. A leftover of an earlier attempt with the same name is dropped.
   */
  async createScratchDatabase(name: string): Promise<void> {
    assertDatabaseName(name);
    await this.asSuperuser('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.query(
        `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' OWNER app_owner`,
      );
      await client.query(
        `GRANT CONNECT ON DATABASE ${name} TO app_rw, app_operator, audit_sealer, app_releaser`,
      );
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
        await client.query(`ALTER DATABASE ${aside} RENAME TO ${DATABASE_NAME}`);
        throw error;
      }
      await client.query(`DROP DATABASE ${aside} WITH (FORCE)`);
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
    await this.asSuperuser(DATABASE_NAME, async (client) => {
      await client.query(script);
    });
  }

  /** `postgres://<role>:<password>@127.0.0.1:<port>/consultorio` for a process of the install. */
  urlFor(role: string, password: string): string {
    if (this.port === null) throw new PostgresError('the database server is not running');
    return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${String(this.port)}/${DATABASE_NAME}`;
  }
}

/** Database names are built by the shell, never typed, but they go into SQL as identifiers all the same. */
function assertDatabaseName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name))
    throw new PostgresError(`unsafe database name: ${name}`);
}
