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

function cluster(overrides: { isPostgresProcess?: (pid: number) => Promise<boolean> } = {}) {
  return new PostgresCluster({
    binDir: 'C:\\pg\\bin',
    pgdata,
    logFile: join(folder, 'logs', 'postgres.log'),
    superuserPassword: 'super-secret-password-0123456789',
    runner,
    connect: (target): SqlClient => ({
      connect: () => Promise.resolve(),
      query: (sql, values) => {
        queries.push({ sql, values, target });
        return Promise.resolve({
          rows: sql.includes('pg_database') && databaseExists ? [{ '?column?': 1 }] : [],
        });
      },
      end: () => Promise.resolve(),
    }),
    freePort: () => Promise.resolve(54321),
    isPostgresProcess: overrides.isPostgresProcess ?? (() => Promise.resolve(false)),
    scratchDir: join(folder, 'tmp'),
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

describe('starting and stopping', () => {
  it('starts with pg_ctl on the free loopback port and waits for it', async () => {
    const port = await cluster().start();

    expect(port).toBe(54321);
    const [call] = calls;
    expect(call?.file).toBe('C:\\pg\\bin\\pg_ctl.exe');
    expect(call?.args.slice(0, 3)).toEqual(['start', '-D', pgdata]);
    expect(call?.args).toContain('-w');
    expect(call?.args.at(-1)).toBe(
      `-p 54321 -c listen_addresses=127.0.0.1 -c max_connections=${String(MAX_CONNECTIONS)}`,
    );
    // pg_ctl leaves the server holding its pipes: the runner must not wait for them to close.
    expect(call?.options?.leavesChildren).toBe(true);
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
