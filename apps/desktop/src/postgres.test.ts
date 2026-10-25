import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_CONNECTIONS,
  PostgresCluster,
  PostgresError,
  type ConnectionTarget,
  type SqlClient,
} from './postgres.js';
import type { RunOptions, RunResult, Runner } from './runner.js';

interface Call {
  file: string;
  args: string[];
  options: RunOptions | undefined;
  /** The password file as it was when initdb was called (it is deleted afterwards). */
  passwordFileText?: string;
}

let folder: string;
let pgdata: string;
let calls: Call[];
let answers: Partial<RunResult>[];
let onRun: (call: Call) => void;
let queries: { sql: string; values: unknown[] | undefined; target: ConnectionTarget }[];
let databaseExists: boolean;
/** A statement containing this text fails (once), as a rename can. */
let failQueryContaining: string | null;

const runner: Runner = (file, args, options) => {
  const call: Call = { file, args, options };
  const passwordArgument = args.find((argument) => argument.startsWith('--pwfile='));
  if (passwordArgument) {
    call.passwordFileText = readFileSync(passwordArgument.slice('--pwfile='.length), 'utf8');
  }
  calls.push(call);
  onRun(call);
  return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...answers.shift() });
};

/** What PostgreSQL writes to postmaster.pid: the process, the folder, the time, the port, ... and the state. */
const pidFileText = (pid: number, port: number, status: string) =>
  [pid, 'C:/data', 1700000000, port, '', '127.0.0.1', 123456, status, ''].join('\n');

let connectFails: number;
let answerRows: Record<string, unknown>[] | null;
let missingTable: boolean;

function cluster(
  overrides: {
    isPostgresProcess?: (pid: number) => Promise<boolean>;
    sleep?: () => Promise<void>;
    startupWaitMs?: number;
  } = {},
) {
  return new PostgresCluster({
    binDir: 'C:\\pg\\bin',
    pgdata,
    logFile: join(folder, 'logs', 'postgres.log'),
    superuserPassword: 'super-secret-password-0123456789',
    ownerPassword: 'owner-secret-password-0123456789',
    runner,
    connect: (target): SqlClient => ({
      connect: () => {
        if (connectFails > 0) {
          connectFails -= 1;
          return Promise.reject(new Error('the database system is not accepting connections'));
        }
        return Promise.resolve();
      },
      query: (sql, values) => {
        queries.push({ sql, values, target });
        if (
          failQueryContaining !== null &&
          sql.includes(failQueryContaining) &&
          sql.includes('consultorio_restore RENAME')
        ) {
          failQueryContaining = null;
          return Promise.reject(new Error('rename failed'));
        }
        if (missingTable && sql.includes('__drizzle_migrations')) {
          return Promise.reject(
            Object.assign(new Error('relation does not exist'), { code: '42P01' }),
          );
        }
        if (answerRows !== null && sql.includes('__drizzle_migrations')) {
          return Promise.resolve({ rows: answerRows });
        }
        return Promise.resolve({
          rows: sql.includes('pg_database') && databaseExists ? [{ '?column?': 1 }] : [],
        });
      },
      end: () => Promise.resolve(),
    }),
    freePort: () => Promise.resolve(54321),
    isPostgresProcess: overrides.isPostgresProcess ?? (() => Promise.resolve(false)),
    scratchDir: join(folder, 'tmp'),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    pollMs: 500,
    startupWaitMs: overrides.startupWaitMs ?? 2000,
  });
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-pg-'));
  pgdata = join(folder, 'pgdata');
  calls = [];
  answers = [];
  onRun = () => undefined;
  queries = [];
  databaseExists = false;
  failQueryContaining = null;
  connectFails = 0;
  answerRows = null;
  missingTable = false;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('creating the cluster', () => {
  it('runs initdb with UTF-8, a scram login and the connection limit of the design', async () => {
    await cluster().initCluster();

    const [call] = calls;
    expect(call?.file).toBe('C:\\pg\\bin\\initdb.exe');
    expect(call?.args).toEqual(
      expect.arrayContaining(['-D', pgdata, '-U', 'postgres', '-A', 'scram-sha-256', '-E', 'UTF8']),
    );
    expect(call?.args).toContain(`max_connections=${String(MAX_CONNECTIONS)}`);
    expect(MAX_CONNECTIONS).toBe(200);
    expect(call?.args).toContain('listen_addresses=127.0.0.1');
  });

  it('passes the superuser password in a file that is gone afterwards, never in an argument', async () => {
    await cluster().initCluster();

    const [call] = calls;
    expect(call?.passwordFileText).toBe('super-secret-password-0123456789');
    expect(call?.args.join(' ')).not.toContain('super-secret-password');
    expect(existsSync(join(folder, 'tmp', `initdb-${String(process.pid)}.pw`))).toBe(false);
  });

  it('removes the password file and reports the failure when initdb fails', async () => {
    answers.push({ code: 1, stderr: 'initdb: error: could not create directory\n' });

    const failure = await cluster()
      .initCluster()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgresError);
    expect((failure as PostgresError).detail).toContain('could not create directory');
    expect(existsSync(join(folder, 'tmp', `initdb-${String(process.pid)}.pw`))).toBe(false);
  });
});

describe('the migrations a database has had applied', () => {
  it('counts the rows of the table the migrator keeps, in the database of the product', async () => {
    const pg = cluster();
    await pg.start();
    answerRows = [{ n: 77 }];

    expect(await pg.appliedMigrationCount()).toBe(77);

    // As app_owner, never as the superuser: a restored database can make this table a view that runs as the reader.
    expect(queries.at(-1)).toMatchObject({
      sql: expect.stringContaining('drizzle.__drizzle_migrations') as string,
      target: {
        database: 'consultorio',
        user: 'app_owner',
        password: 'owner-secret-password-0123456789',
      },
    });
  });

  it('says null for a database that has none yet: a first run, not an old version', async () => {
    const pg = cluster();
    await pg.start();
    missingTable = true;

    expect(await pg.appliedMigrationCount()).toBeNull();
  });
});

describe('reading what a backup may have written', () => {
  it('reads the scratch database as app_owner, and the catalogs of the cluster in the postgres database', async () => {
    const pg = cluster();
    await pg.start();

    await pg.scratchFacts('consultorio_restore');

    const inScratch = queries.filter((query) => query.target.database === 'consultorio_restore');
    expect(inScratch.length).toBeGreaterThan(0);
    for (const query of inScratch) expect(query.target.user).toBe('app_owner');
    const inCatalogs = queries.filter((query) => query.target.database === 'postgres');
    expect(inCatalogs.length).toBeGreaterThan(0);
  });

  it('never runs a query of the superuser inside a database a backup may have written', async () => {
    const pg = cluster();
    await pg.start();
    await pg.clusterFacts('consultorio');
    await pg.scratchFacts('consultorio_restore');
    await pg.appliedMigrationCount();

    const superuserInside = queries.filter(
      (query) =>
        query.target.user === 'postgres' &&
        (query.target.database === 'consultorio' ||
          query.target.database === 'consultorio_restore'),
    );
    expect(superuserInside).toEqual([]);
  });

  it('refuses a name that is not a plain database name', async () => {
    const pg = cluster();
    await pg.start();

    await expect(pg.scratchFacts('x; drop database consultorio')).rejects.toThrow(/unsafe/);
  });

  it('runs the statements that put the roles back, as the superuser, in the postgres database', async () => {
    const pg = cluster();
    await pg.start();

    await pg.executeStatements(['REVOKE "audit_sealer" FROM "app_rw" GRANTED BY "app_owner"']);

    expect(queries.at(-1)).toMatchObject({
      sql: 'REVOKE "audit_sealer" FROM "app_rw" GRANTED BY "app_owner"',
      target: { user: 'postgres', database: 'postgres' },
    });
  });
});

describe('asking the server whether it is alive', () => {
  it('says yes when it answers a query', async () => {
    const pg = cluster();
    await pg.start();

    expect(await pg.ping()).toBe(true);
    expect(queries.at(-1)?.sql).toBe('SELECT 1');
  });

  it('says no, instead of failing, when it does not answer', async () => {
    const pg = cluster();
    await pg.start();
    connectFails = 1;

    expect(await pg.ping()).toBe(false);
  });

  it('says no when the server was never started', async () => {
    expect(await cluster().ping()).toBe(false);
  });
});

describe('the databases of the server', () => {
  it('lists their names', async () => {
    const pg = cluster();
    await pg.start();

    const names = await pg.listDatabases();

    expect(names).toEqual([]);
    expect(queries.at(-1)?.sql).toContain('pg_database');
  });

  it('renames one after sending away whoever is connected, and refuses a name that is not safe', async () => {
    const pg = cluster();
    await pg.start();

    await pg.renameDatabase('consultorio_before_restore', 'consultorio');

    expect(queries.map((query) => query.sql).join('\n')).toContain(
      'ALTER DATABASE consultorio_before_restore RENAME TO consultorio',
    );
    expect(queries.map((query) => query.sql).join('\n')).toContain('pg_terminate_backend');
    await expect(pg.renameDatabase('a; drop database consultorio', 'b')).rejects.toThrow(/unsafe/);
  });
});

describe('starting and stopping', () => {
  it('starts with pg_ctl on the free loopback port and waits for it', async () => {
    const port = await cluster().start();

    expect(port).toBe(54321);
    const [call] = calls;
    expect(call?.file).toBe('C:\\pg\\bin\\pg_ctl.exe');
    expect(call?.args.slice(0, 3)).toEqual(['start', '-D', pgdata]);
    expect(call?.args).toContain('-w');
    expect(call?.args.at(-1)).toContain(
      `-p 54321 -c listen_addresses=127.0.0.1 -c max_connections=${String(MAX_CONNECTIONS)}`,
    );
    // pg_ctl leaves the server holding its pipes: the runner must not wait for them to close.
    expect(call?.options?.leavesChildren).toBe(true);
  });

  it('starts the server quiet: no statement text, no detail of a row, no connection lines', async () => {
    await cluster().start();

    const options = calls[0]?.args.at(-1) ?? '';
    // A statement that failed would be written to the log with the data it carried.
    expect(options).toContain('-c log_min_error_statement=panic');
    expect(options).toContain('-c log_error_verbosity=terse');
    expect(options).toContain('-c log_connections=off');
  });

  it('moves a log that has grown too big aside before the server opens it', async () => {
    mkdirSync(join(folder, 'logs'), { recursive: true });
    writeFileSync(join(folder, 'logs', 'postgres.log'), 'x'.repeat(6 * 1024 * 1024));

    await cluster().start();

    expect(existsSync(join(folder, 'logs', 'postgres.log'))).toBe(false);
    expect(existsSync(join(folder, 'logs', 'postgres.log.1'))).toBe(true);
  });

  it('reports a server that did not start, with the tail of what pg_ctl said', async () => {
    answers.push({ code: 1, stderr: 'pg_ctl: could not start server\n' });

    await expect(cluster().start()).rejects.toMatchObject({
      name: 'PostgresError',
      detail: expect.stringContaining('could not start server') as string,
    });
  });

  it('stops with pg_ctl stop -m fast when the server is running', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), '4242\n');
    const pg = cluster({ isPostgresProcess: () => Promise.resolve(true) });
    answers.push({}, {});

    await pg.start();
    await pg.stop();

    const stop = calls.find((call) => call.args[0] === 'stop');
    expect(stop?.args).toEqual(expect.arrayContaining(['stop', '-D', pgdata, '-m', 'fast', '-w']));
    expect(pg.runningPort).toBeNull();
  });

  it('has nothing to stop when there is no postmaster.pid', async () => {
    await cluster().stop();

    expect(calls).toHaveLength(0);
  });
});

describe('a postmaster.pid left behind', () => {
  it('is removed when no server owns it', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), '31337\nC:/data\n');

    await cluster({ isPostgresProcess: () => Promise.resolve(false) }).start();

    expect(existsSync(join(pgdata, 'postmaster.pid'))).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual(['start']);
  });

  it('is removed when its process number now belongs to another program', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), '4\n');

    // The check looks at the image name of the process, not only at whether the number is alive.
    await cluster({ isPostgresProcess: (pid) => Promise.resolve(pid === 999) }).start();

    expect(calls.map((call) => call.args[0])).toEqual(['start']);
  });

  it('adopts a server that is up and answering instead of stopping it: the same run, a new window', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), pidFileText(4242, 54555, 'ready'));
    const pg = cluster({ isPostgresProcess: (pid) => Promise.resolve(pid === 4242) });

    const port = await pg.start();

    expect(port).toBe(54555);
    expect(pg.runningPort).toBe(54555);
    expect(calls).toHaveLength(0);
  });

  it('waits for a server that is still starting, which is what a retry after a slow start meets', async () => {
    mkdirSync(pgdata, { recursive: true });
    const pidFile = join(pgdata, 'postmaster.pid');
    writeFileSync(pidFile, pidFileText(4242, 54555, 'starting'));
    let sleeps = 0;
    const pg = cluster({
      isPostgresProcess: (pid) => Promise.resolve(pid === 4242),
      sleep: () => {
        sleeps += 1;
        if (sleeps === 2) writeFileSync(pidFile, pidFileText(4242, 54555, 'ready'));
        return Promise.resolve();
      },
    });

    const port = await pg.start();

    expect(port).toBe(54555);
    expect(sleeps).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('waits for a server that is stopping to go, and then starts a new one', async () => {
    mkdirSync(pgdata, { recursive: true });
    const pidFile = join(pgdata, 'postmaster.pid');
    writeFileSync(pidFile, pidFileText(4242, 54555, 'stopping'));
    const pg = cluster({
      isPostgresProcess: (pid) => Promise.resolve(pid === 4242),
      sleep: () => {
        rmSync(pidFile, { force: true });
        return Promise.resolve();
      },
    });

    const port = await pg.start();

    expect(port).toBe(54321);
    expect(calls.map((call) => call.args[0])).toEqual(['start']);
  });

  it('stops a server that never gets ready, cleanly, and starts a new one', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), pidFileText(4242, 54555, 'starting'));

    await cluster({ isPostgresProcess: (pid) => Promise.resolve(pid === 4242) }).start();

    expect(calls.map((call) => call.args[0])).toEqual(['stop', 'start']);
  });

  it('stops a server that says it is ready but does not answer', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), pidFileText(4242, 54555, 'ready'));
    connectFails = 100;

    await cluster({ isPostgresProcess: (pid) => Promise.resolve(pid === 4242) }).start();

    expect(calls.map((call) => call.args[0])).toEqual(['stop', 'start']);
  });

  it('stops a server that is still running, cleanly, before starting a new one', async () => {
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), '4242\n');

    await cluster({ isPostgresProcess: (pid) => Promise.resolve(pid === 4242) }).start();

    expect(calls.map((call) => call.args[0])).toEqual(['stop', 'start']);
    expect(calls[0]?.args).toContain('fast');
  });
});

describe('the database', () => {
  it('is created once, as the superuser, when it does not exist', async () => {
    const pg = cluster();
    await pg.start();

    await pg.ensureDatabase();
    databaseExists = true;
    await pg.ensureDatabase();

    const creations = queries.filter((query) => query.sql.startsWith('CREATE DATABASE'));
    expect(creations).toHaveLength(1);
    expect(creations[0]?.sql).toBe("CREATE DATABASE consultorio ENCODING 'UTF8'");
    expect(creations[0]?.target).toMatchObject({
      host: '127.0.0.1',
      port: 54321,
      user: 'postgres',
      database: 'postgres',
    });
  });

  it('runs a script in the database of the product', async () => {
    const pg = cluster();
    await pg.start();

    await pg.runScript('SELECT 1;');

    expect(queries.at(-1)).toMatchObject({ sql: 'SELECT 1;', target: { database: 'consultorio' } });
  });

  it('restores into a scratch database set up like the real one, then swaps it in', async () => {
    const pg = cluster();
    await pg.start();

    await pg.createScratchDatabase('consultorio_restore');
    await pg.swapInDatabase('consultorio_restore');

    const sql = queries.map((query) => query.sql);
    expect(sql[0]).toBe('DROP DATABASE IF EXISTS consultorio_restore WITH (FORCE)');
    expect(sql[1]).toBe(
      "CREATE DATABASE consultorio_restore TEMPLATE template0 ENCODING 'UTF8' OWNER app_owner",
    );
    expect(sql[2]).toContain('GRANT CONNECT ON DATABASE consultorio_restore TO app_rw');
    expect(sql).toContain('ALTER DATABASE consultorio RENAME TO consultorio_before_restore');
    expect(sql).toContain('ALTER DATABASE consultorio_restore RENAME TO consultorio');
    expect(sql.at(-1)).toBe('DROP DATABASE consultorio_before_restore WITH (FORCE)');
    // Always as the superuser, from the maintenance database: nobody can be connected to the ones renamed.
    expect(queries.every((query) => query.target.database === 'postgres')).toBe(true);
  });

  it('puts the old database back when the swap fails half way', async () => {
    const pg = cluster();
    await pg.start();
    failQueryContaining = 'RENAME TO consultorio';

    await expect(pg.swapInDatabase('consultorio_restore')).rejects.toThrow('rename failed');

    const renames = queries.map((query) => query.sql).filter((sql) => sql.includes('RENAME'));
    expect(renames.at(-1)).toBe('ALTER DATABASE consultorio_before_restore RENAME TO consultorio');
  });

  it('does not fail a swap that worked because the old database could not be dropped', async () => {
    const pg = cluster();
    await pg.start();
    failQueryContaining = 'DROP DATABASE consultorio_before_restore';

    await expect(pg.swapInDatabase('consultorio_restore')).resolves.toBeUndefined();

    const sql = queries.map((query) => query.sql);
    expect(sql).toContain('ALTER DATABASE consultorio_restore RENAME TO consultorio');
  });

  it('refuses a database name that is not a plain identifier', async () => {
    const pg = cluster();
    await pg.start();

    await expect(pg.createScratchDatabase('x; DROP DATABASE consultorio')).rejects.toBeInstanceOf(
      PostgresError,
    );
    await expect(pg.dropDatabase('Consultorio')).rejects.toBeInstanceOf(PostgresError);
  });

  it('refuses to connect before the server is running', async () => {
    await expect(cluster().ensureDatabase()).rejects.toBeInstanceOf(PostgresError);
  });

  it('builds the URL of a login with the password encoded', async () => {
    const pg = cluster();
    await pg.start();

    expect(pg.urlFor('app_rw', 'p@ss/word')).toBe(
      'postgres://app_rw:p%40ss%2Fword@127.0.0.1:54321/consultorio',
    );
  });
});
