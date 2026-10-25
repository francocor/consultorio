import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
   * Makes the data folder startable. A `postmaster.pid` left by a crash is either dead, and removed, or
   * a server that is still alive (the shell was killed and the server was not): that one is stopped
   * cleanly first, because it listens on a port nobody knows any more.
   */
  async recoverStalePid(): Promise<void> {
    const pidFile = join(this.options.pgdata, 'postmaster.pid');
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
    if (Number.isInteger(pid) && pid > 0 && (await this.options.isPostgresProcess(pid))) {
      this.log(`a previous server (pid ${String(pid)}) is still running; stopping it`);
      await this.stop();
      return;
    }
    rmSync(pidFile, { force: true });
    this.log('removed a stale postmaster.pid');
  }

  /** Starts the server on a free loopback port and returns the port. */
  async start(): Promise<number> {
    const { pgdata, logFile, runner } = this.options;
    await this.recoverStalePid();
    mkdirSync(dirname(logFile), { recursive: true });
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
        `-p ${String(port)} -c listen_addresses=127.0.0.1 -c max_connections=${String(MAX_CONNECTIONS)}`,
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
