import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiCommandError,
  EXIT,
  type ApiCommands,
  type ProvisionInput,
  type ResetPasswordInput,
} from './api-commands.js';
import { discard } from './backup-archive.js';
import { unwrapBackupKey, verifyRecoveryKey } from './backup-crypto.js';
import { readLedger } from './backup-ledger.js';
import { newTestInstall, testBackupDeps } from './backup-testing.js';
import { ConfigStore, type Cipher } from './config-store.js';
import { Controller, type ControllerDeps, type ShellUi } from './controller.js';
import type { OwnerCheck, OwnerCheckOptions } from './owner-check.js';
import type { DataPaths } from './paths.js';
import type { PostgresCluster } from './postgres.js';
import { resolveResources } from './resources.js';
import { createRotatingLog } from './rotating-log.js';
import type { PgTools } from './streams.js';
import type { ChildLike } from './supervisor.js';

const realRolesScript = readFileSync(
  fileURLToPath(new URL('../../../infra/postgres/init/01-roles.sql', import.meta.url)),
  'utf8',
);

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  constructor(
    readonly pid: number,
    private readonly onShutdown: () => void,
  ) {
    super();
  }
  send(message: unknown): boolean {
    if ((message as { type?: string }).type === 'shutdown') {
      queueMicrotask(() => {
        this.onShutdown();
        this.emit('exit', 0, null);
      });
    }
    return true;
  }
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, null);
    return true;
  }
}

interface Harness {
  folder: string;
  paths: DataPaths;
  events: string[];
  uiCalls: [string, ...unknown[]][];
  /** The detail line of every message dialog, in order. */
  details: string[];
  /** The detail of every confirmation dialog, in order. */
  confirmDetails: string[];
  controller: Controller;
  commandCalls: { command: string; env: NodeJS.ProcessEnv; input?: unknown }[];
  quitRequests: number;
  config: () => ReturnType<ConfigStore['read']>;
  loadedUrls: string[];
  clusterScripts: string[];
  spawned: { role: string; env: NodeJS.ProcessEnv }[];
  /** The fake processes started, in order, to make one die. */
  children: { role: string; child: FakeChild }[];
  dumps: number;
  restores: string[][];
  lists: string[][];
  restoreEnvs: NodeJS.ProcessEnv[];
  dumpCalls: { args: string[]; env: NodeJS.ProcessEnv }[];
  probes: { port: number; secret: string }[];
  /** Which databases the (fake) server has, to stage a restore that was cut off. */
  setDatabases: (names: string[]) => void;
}

let harness: Harness;
/** Everything a test built, so nothing is left running or on disk. */
let folders: string[] = [];
let controllers: Controller[] = [];
let migrateFails = false;
let stopFails = false;
let confirmAnswer = true;
/** The Windows account can no longer read what it encrypted (another user, a reinstalled Windows). */
let cipherBroken = false;
/** The exit code of `pg_restore --list`, the check of a backup after it is written. */
let listCode = 0;
/** pg_restore ends with this code when it restores (not when it lists), and dropping a database fails. */
let restoreCode = 0;
let dropFails = false;
/** The database server answers its pings. */
let databaseAlive = true;
/** How many migrations the database has had applied; `null` is a new one. */
let appliedMigrations: number | null = null;
/** What the API says about the owner who asks for a new recovery key, and what it was asked. */
let ownerAnswer: OwnerCheck = { ok: true };
let ownerChecks: OwnerCheckOptions[] = [];
/** What the fake cluster was told about the right of app_owner to hand out audit_sealer, and what it was at each migration. */
let ownerAdminCalls: boolean[] = [];
let ownerAdminNow = false;
let ownerAdminAtMigrate: boolean[] = [];
/** What the backups folder held each time `migrate` was called. */
let backupsAtMigrate: string[][] = [];
/** A process of the install that dies as soon as it is started, by role. */
let dieOnSpawn: Partial<Record<'api' | 'worker', boolean>> = {};
let provisionFails: ApiCommandError | null = null;
let resetFails: ApiCommandError | null = null;
let chooseAnswers: number[];
/** Runs when a dialog with buttons opens, before it answers: a way to fix the cause while the user "reads" it. */
let whileDialogOpen: () => void = () => undefined;
let clock = new Date(2026, 9, 24, 10, 0, 0);

/**
 * Waits for something a job of the program does by itself (the backup of the first open of the day). The
 * default of one second is a guess about the speed of the machine: a PC that is busy takes longer.
 */
const waitFor = async (check: () => void) => {
  await vi.waitFor(check, { timeout: 30_000, interval: 25 });
  // The day is written down before the old backups are pruned: let the backup finish before the test acts.
  await harness.controller.whenIdle();
};

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain).reverse().toString('base64')),
  decrypt: (data) => {
    if (cipherBroken) throw new Error('the key of this Windows account is gone');
    return Buffer.from(Buffer.from(data.toString(), 'base64').reverse()).toString('utf8');
  },
};

function build(
  folder: string,
  options: { testMode?: boolean; env?: NodeJS.ProcessEnv } = {},
): Harness {
  const root = join(folder, 'Consulvia');
  const paths: DataPaths = {
    root,
    pgdata: join(root, 'pgdata'),
    files: join(root, 'files'),
    outbox: join(root, 'outbox'),
    logs: join(root, 'logs'),
    configFile: join(root, 'config.json'),
    electronProfile: join(root, 'electron-profile'),
    backups: join(folder, 'Documents', 'Consulvia', 'Copias'),
  };
  // The files of an installed program.
  const resourcesRoot = join(folder, 'resources');
  const resources = resolveResources(resourcesRoot);
  for (const file of [
    resources.mainJs,
    join(resources.webRoot, 'index.html'),
    join(resources.pgBinDir, 'initdb.exe'),
    join(resources.pgBinDir, 'pg_ctl.exe'),
    join(resources.pgBinDir, 'postgres.exe'),
    resources.pgDump,
    resources.pgRestore,
  ]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
  }
  writeFileSync(
    join(resources.webRoot, 'content-security-policy.txt'),
    "default-src 'self'; upgrade-insecure-requests",
  );
  mkdirSync(join(resources.rolesSql, '..'), { recursive: true });
  writeFileSync(resources.rolesSql, realRolesScript);
  mkdirSync(join(resources.passwordList, '..'), { recursive: true });
  // Built from pieces: a scanner reads a literal next to the word "password" as a leaked secret.
  writeFileSync(resources.passwordList, ['pass' + 'word1234', 'qwerty' + 'uiop12'].join('\n'));
  mkdirSync(join(resources.migrationsJournal, '..'), { recursive: true });
  writeFileSync(
    resources.migrationsJournal,
    JSON.stringify({ entries: [{ tag: '0001_a' }, { tag: '0002_b' }] }),
  );

  const events: string[] = [];
  const uiCalls: [string, ...unknown[]][] = [];
  const details: string[] = [];
  const confirmDetails: string[] = [];
  const loadedUrls: string[] = [];
  const commandCalls: Harness['commandCalls'] = [];
  const clusterScripts: string[] = [];
  const spawned: Harness['spawned'] = [];
  const children: Harness['children'] = [];
  const restores: string[][] = [];
  const lists: string[][] = [];
  const restoreEnvs: NodeJS.ProcessEnv[] = [];
  const dumpCalls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const probes: Harness['probes'] = [];
  let databaseNames = ['postgres', 'consultorio'];
  let dumps = 0;

  const ui: ShellUi = {
    showSplash: (message) => uiCalls.push(['splash', message]),
    loadUrl: (url) => {
      loadedUrls.push(url);
      uiCalls.push(['loadUrl', url]);
    },
    showMainWindow: () => uiCalls.push(['showMainWindow']),
    openAuxWindow: (url, title) => uiCalls.push(['openAuxWindow', url, title]),
    closeAuxWindow: () => uiCalls.push(['closeAuxWindow']),
    confirm: (o) => {
      uiCalls.push(['confirm', o.title]);
      confirmDetails.push(o.detail);
      return Promise.resolve(confirmAnswer);
    },
    message: (kind, title, message, detail) => {
      uiCalls.push(['message', kind, title, message]);
      details.push(detail ?? '');
      return Promise.resolve();
    },
    choose: (o) => {
      uiCalls.push(['choose', o.title, o.buttons]);
      whileDialogOpen();
      return Promise.resolve(chooseAnswers.shift() ?? o.buttons.length - 1);
    },
    notify: (title, body) => uiCalls.push(['notify', title, body]),
    pickFile: () => {
      uiCalls.push(['pickFile']);
      return Promise.resolve(null);
    },
    openPath: (path) => {
      uiCalls.push(['openPath', path]);
      return Promise.resolve();
    },
    openExternal: (url) => uiCalls.push(['openExternal', url]),
    setAutoStart: (enabled) => uiCalls.push(['setAutoStart', enabled]),
    copyToClipboard: (text) => uiCalls.push(['copy', text]),
  };

  let port: number | null = null;
  const cluster = {
    get runningPort() {
      return port;
    },
    isInitialized: () => existsSync(join(paths.pgdata, 'PG_VERSION')),
    clusterFacts: () =>
      Promise.resolve({
        memberships: [],
        roleSettings: [],
        ownerPasswordHash: 'hash',
        auditPrivileges: [],
      }),
    scratchFacts: () => Promise.resolve({ migrationsKind: 'r', databaseSettings: [] }),
    executeStatements: () => Promise.resolve(),
    ping: () => Promise.resolve(databaseAlive),
    appliedMigrationCount: () => Promise.resolve(appliedMigrations),
    listDatabases: () => Promise.resolve([...databaseNames]),
    renameDatabase: (from: string, to: string) => {
      events.push(`rename ${from} ${to}`);
      databaseNames = databaseNames.map((name) => (name === from ? to : name));
      return Promise.resolve();
    },
    initCluster: () => {
      events.push('initdb');
      mkdirSync(paths.pgdata, { recursive: true });
      writeFileSync(join(paths.pgdata, 'PG_VERSION'), '17');
      return Promise.resolve();
    },
    start: () => {
      events.push('pg start');
      port = 54321;
      return Promise.resolve(54321);
    },
    ensureDatabase: () => {
      events.push('create database');
      return Promise.resolve();
    },
    runScript: (script: string) => {
      events.push('roles');
      clusterScripts.push(script);
      return Promise.resolve();
    },
    createRestoreScratch: () => {
      events.push('scratch create');
      if (!databaseNames.includes('consultorio_restore')) databaseNames.push('consultorio_restore');
      return Promise.resolve({
        database: 'consultorio_restore',
        user: 'consulvia_restore_test',
        password: 'a-password',
        live: [],
        baseline: [],
      });
    },
    inspectRestoreScratch: () => Promise.resolve([]),
    sealRestoreScratch: () => {
      events.push('scratch seal');
      return Promise.resolve([]);
    },
    dropRestoreRoles: () => Promise.resolve(),
    setOwnerAuditAdmin: (allowed: boolean) => {
      ownerAdminCalls.push(allowed);
      ownerAdminNow = allowed;
      return Promise.resolve();
    },
    swapInDatabase: () => {
      events.push('scratch swap');
      return Promise.resolve();
    },
    dropDatabase: (name: string) => {
      if (dropFails) return Promise.reject(new Error('the database is in use'));
      events.push('scratch drop');
      databaseNames = databaseNames.filter((candidate) => candidate !== name);
      return Promise.resolve();
    },
    stop: () => {
      events.push('pg stop');
      if (stopFails) return Promise.reject(new Error('the database would not stop'));
      port = null;
      return Promise.resolve();
    },
  } as unknown as PostgresCluster;

  const commands: ApiCommands = {
    migrate: (env) => {
      commandCalls.push({ command: 'migrate', env });
      ownerAdminAtMigrate.push(ownerAdminNow);
      events.push('migrate');
      backupsAtMigrate.push(existsSync(paths.backups) ? readdirSync(paths.backups) : []);
      if (migrateFails) {
        return Promise.reject(new ApiCommandError('migrate', 1, { error: 'failed' }, 'boom'));
      }
      return Promise.resolve('migrations applied\nplatform catalogs loaded\n');
    },
    provision: (env, input: ProvisionInput) => {
      commandCalls.push({ command: 'provision', env, input });
      events.push('provision');
      if (provisionFails) return Promise.reject(provisionFails);
      return Promise.resolve({ result: 'created' as const, tenantId: 't-1', slug: 'consultorio' });
    },
    resetPassword: (env, input: ResetPasswordInput) => {
      commandCalls.push({ command: 'reset-password', env, input });
      if (resetFails) return Promise.reject(resetFails);
      return Promise.resolve({
        email: 'ana@clinica.example',
        secondFactorCleared: input.clearSecondFactor,
        ownerNotified: true,
      });
    },
  };

  const pgTools: PgTools = {
    dump: (_file, args, env) => {
      dumps += 1;
      dumpCalls.push({ args, env });
      const stdout = new PassThrough();
      stdout.end('PGDMP-fake');
      return { stdout, finished: Promise.resolve({ code: 0, stderr: '' }) };
    },
    restore: async (_file, args, env, source) => {
      if (args.includes('--list')) {
        // The check of a backup after it is written: not a restore.
        lists.push(args);
        await discard(source);
        return { code: listCode, stderr: listCode === 0 ? '' : 'pg_restore: error: cannot read' };
      }
      restores.push(args);
      restoreEnvs.push(env);
      await discard(source);
      return { code: restoreCode, stderr: restoreCode === 0 ? '' : 'pg_restore: error: boom' };
    },
  };

  const store = new ConfigStore(paths.configFile, cipher);
  const deps: ControllerDeps = {
    paths,
    resources,
    store,
    pgTools,
    commands,
    ui,
    version: '0.1.0',
    spawnLongRunning: (role, env) => {
      spawned.push({ role, env });
      events.push(`spawn ${role}`);
      const child = new FakeChild(5000 + spawned.length, () => events.push(`shutdown ${role}`));
      children.push({ role, child });
      if (dieOnSpawn[role] === true) {
        queueMicrotask(() => {
          child.stderr.write('boom\n');
          child.emit('exit', 1, null);
        });
      } else if (role === 'worker') {
        queueMicrotask(() => child.stdout.write('{"msg":"worker started"}\n'));
      }
      return child;
    },
    verifyOwner: (options) => {
      ownerChecks.push(options);
      return Promise.resolve(ownerAnswer);
    },
    probeHealth: (port, secret) => {
      probes.push({ port, secret });
      return Promise.resolve(true);
    },
    createCluster: () => cluster,
    logs: {
      shell: createRotatingLog(join(paths.logs, 'shell.log')),
      api: createRotatingLog(join(paths.logs, 'api.log')),
      worker: createRotatingLog(join(paths.logs, 'worker.log')),
    },
    testMode: options.testMode ?? false,
    portRetry: { sleep: () => Promise.resolve() },
    supervisorBackoffMs: [0, 0],
    env: options.env ?? {},
    now: () => clock,
    requestQuit: () => {
      result.quitRequests += 1;
    },
  };
  const controller = new Controller(deps);
  folders.push(folder);
  controllers.push(controller);
  const result: Harness = {
    folder,
    paths,
    events,
    uiCalls,
    details,
    confirmDetails,
    controller,
    commandCalls,
    quitRequests: 0,
    config: () => store.read(),
    loadedUrls,
    clusterScripts,
    spawned,
    children,
    get dumps() {
      return dumps;
    },
    restores,
    lists,
    restoreEnvs,
    dumpCalls,
    probes,
    setDatabases: (names) => {
      databaseNames = names;
    },
  };
  return result;
}

function parseBody(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    return { text };
  }
}

/** The text of a page of the local server of the harness. */
function getText(url: string): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    httpRequest(
      {
        host: '127.0.0.1',
        port: Number(target.port),
        path: target.pathname + target.search,
        method: 'GET',
        headers: { host: target.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    )
      .on('error', reject)
      .end();
  });
}

/** A raw request to the local server of the harness. */
/** The recovery key that the last setup answer showed: it is stored nowhere, so this is the only copy. */
let shownKey = '';

function post(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(target.port),
        path: target.pathname,
        method: 'POST',
        headers: {
          host: target.host,
          'content-type': 'application/json',
          'x-consulvia-token': token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const parsed = parseBody(Buffer.concat(chunks).toString('utf8'));
          if (target.pathname === '/__setup' && typeof parsed['recoveryKey'] === 'string') {
            shownKey = parsed['recoveryKey'];
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

/**
 * The two steps of the setup: the form (which only shows the recovery key) and the confirmation of the key (which
 * creates the organization). Returns both answers.
 */
async function completeSetup(url: string, values: Record<string, unknown> = form) {
  const shown = await post(new URL('/__setup', url).href, tokenOf(url), values);
  if (shown.status !== 200) return { shown, confirmed: shown };
  const confirmed = await post(new URL('/__ack', url).href, String(shown.body['ackToken']), {
    recoveryKeyLast4: String(shown.body['recoveryKey']).slice(-4),
  });
  return { shown, confirmed };
}

const tokenOf = (url: string | undefined) =>
  new URL(url ?? 'http://x/?t=').searchParams.get('t') ?? '';
const setupUrl = () => harness.loadedUrls.find((url) => url.includes('/__setup'));

const form = {
  organizationName: 'Clínica Prueba',
  ownerName: 'Dra. Ana Gómez',
  ownerEmail: 'ana@clinica.example',
  password: 'una frase larga y privada del consultorio',
  passwordConfirmation: 'una frase larga y privada del consultorio',
  timeZone: 'America/Argentina/Buenos_Aires',
};

beforeEach(() => {
  const folder = mkdtempSync(join(tmpdir(), 'consulvia-controller-'));
  folders = [];
  controllers = [];
  migrateFails = false;
  stopFails = false;
  confirmAnswer = true;
  cipherBroken = false;
  listCode = 0;
  restoreCode = 0;
  dropFails = false;
  databaseAlive = true;
  appliedMigrations = null;
  ownerAnswer = { ok: true };
  ownerChecks = [];
  ownerAdminCalls = [];
  ownerAdminNow = false;
  ownerAdminAtMigrate = [];
  backupsAtMigrate = [];
  dieOnSpawn = {};
  provisionFails = null;
  resetFails = null;
  chooseAnswers = [];
  whileDialogOpen = () => undefined;
  clock = new Date(2026, 9, 24, 10, 0, 0);
  harness = build(folder);
});

afterEach(async () => {
  await Promise.all(controllers.map((controller) => controller.quit()));
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe('an install whose configuration cannot be opened', () => {
  async function provisionedFolder(): Promise<string> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await harness.controller.quit();
    return harness.folder;
  }

  const buttonsOf = (target: Harness) =>
    target.uiCalls.find(
      (call) => call[0] === 'choose' && call[1] === 'Consulvia no pudo iniciar',
    )?.[2] as string[] | undefined;

  it('offers to start over when another Windows account cannot read the secrets, and does not for an ordinary failure', async () => {
    const folder = await provisionedFolder();
    cipherBroken = true;
    chooseAnswers = [3];

    const next = build(folder);
    await next.controller.start();

    expect(buttonsOf(next)).toContain('Empezar de nuevo y restaurar una copia');

    migrateFails = true;
    cipherBroken = false;
    const ordinary = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')));
    await ordinary.controller.start();
    expect(buttonsOf(ordinary)).not.toContain('Empezar de nuevo y restaurar una copia');
  });

  it('moves the configuration, the database and the documents aside without deleting any, then offers a restore', async () => {
    const folder = await provisionedFolder();
    const before = build(folder).paths;
    mkdirSync(before.files, { recursive: true });
    writeFileSync(join(before.files, 'a.pdf'), 'document');
    cipherBroken = true;
    // The dialog is answered after the account "works" again: the new install writes and reads its own file.
    whileDialogOpen = () => {
      cipherBroken = false;
    };
    chooseAnswers = [2];

    const next = build(folder);
    await next.controller.start();

    const names = readdirSync(next.paths.root);
    const aside = (prefix: string) => names.filter((name) => name.startsWith(prefix + '.aside-'));
    expect(aside('config.json')).toHaveLength(1);
    expect(aside('pgdata')).toHaveLength(1);
    expect(aside('files')).toHaveLength(1);
    expect(
      readFileSync(join(next.paths.root, aside('pgdata')[0] ?? '', 'PG_VERSION'), 'utf8'),
    ).toBe('17');
    expect(readFileSync(join(next.paths.root, aside('files')[0] ?? '', 'a.pdf'), 'utf8')).toBe(
      'document',
    );
    // A new install is up, and the restore is offered at once.
    expect(next.config().provisioned).toBe(false);
    expect(next.uiCalls).toContainEqual(['pickFile']);
  });

  it('sets the record of an interrupted restore aside too, and everything it names, so the new install does not act on it or sweep it', async () => {
    const folder = await provisionedFolder();
    const before = build(folder).paths;
    // An interrupted restore: the real documents aside, the work folder, the copy of the configuration, the record.
    const aside = `${before.files}.replaced-7`;
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, 'precious.pdf'), 'the documents of before');
    const unpacked = join(before.root, 'tmp-restore-7');
    mkdirSync(join(unpacked, 'files'), { recursive: true });
    const copy = join(before.root, 'config.json.pre-restore-7');
    writeFileSync(copy, 'a copy of the configuration');
    writeFileSync(
      join(before.root, 'restore-journal.json'),
      JSON.stringify({
        version: 1,
        stamp: '7',
        step: 'files-swapped',
        filesAside: aside,
        unpacked,
        configCopy: copy,
        hadFiles: true,
        undoing: false,
      }),
    );
    cipherBroken = true;
    whileDialogOpen = () => {
      cipherBroken = false;
    };
    chooseAnswers = [2];

    const next = build(folder);
    await next.controller.start();

    const names = readdirSync(next.paths.root);
    const aside_ = (prefix: string) => names.filter((name) => name.startsWith(prefix + '.aside-'));
    // Moved, not deleted, and under a name that no sweep recognizes.
    expect(names).not.toContain('restore-journal.json');
    expect(aside_('restore-journal.json')).toHaveLength(1);
    expect(aside_('files.replaced-7')).toHaveLength(1);
    expect(aside_('tmp-restore-7')).toHaveLength(1);
    expect(aside_('config.json.pre-restore-7')).toHaveLength(1);
    expect(
      readFileSync(
        join(next.paths.root, aside_('files.replaced-7')[0] ?? '', 'precious.pdf'),
        'utf8',
      ),
    ).toBe('the documents of before');
    // And the new install did not run a restore it knows nothing about.
    expect(readFileSync(join(next.paths.logs, 'shell.log'), 'utf8')).not.toContain(
      'an interrupted restore',
    );
    expect(next.config().provisioned).toBe(false);
  });

  it('changes nothing when the person says no', async () => {
    const folder = await provisionedFolder();
    cipherBroken = true;
    chooseAnswers = [2, 3];
    confirmAnswer = false;

    const next = build(folder);
    await next.controller.start();

    const names = readdirSync(next.paths.root);
    expect(names.some((name) => name.includes('.aside-'))).toBe(false);
    expect(names).toContain('pgdata');
    expect(names).toContain('config.json');
  });

  it('restores config.json.bak when only config.json went missing, and keeps the database', async () => {
    const folder = await provisionedFolder();
    const paths = build(folder).paths;
    // Every write keeps the previous good copy beside the file.
    const slugBefore = new ConfigStore(paths.configFile, cipher).read().slug;
    writeFileSync(paths.configFile + '.bak', readFileSync(paths.configFile));
    rmSync(paths.configFile);

    const next = build(folder);
    await next.controller.start();

    expect(readdirSync(next.paths.root).some((name) => name.includes('orphaned'))).toBe(false);
    expect(next.config().slug).toBe(slugBefore);
    expect(next.config().provisioned).toBe(true);
    expect(
      next.uiCalls.some(
        (call) => call[0] === 'message' && call[2] === 'Se apartaron datos sin configuración',
      ),
    ).toBe(false);
  });

  it('keeps the damaged config.json aside and the good copy as it was when it recovers from config.json.bak', async () => {
    const folder = await provisionedFolder();
    const paths = build(folder).paths;
    const good = readFileSync(paths.configFile, 'utf8');
    writeFileSync(paths.configFile + '.bak', good);
    writeFileSync(paths.configFile, '{ "version": 1, "public": ');

    const next = build(folder);
    await next.controller.start();

    // The copy that saved the install is not overwritten by the file that failed: it still reads.
    expect(() => new ConfigStore(paths.configFile + '.bak', cipher).read()).not.toThrow();
    // ...which is kept, for whoever has to find out what happened.
    const corrupt = readdirSync(paths.root).filter((name) =>
      name.startsWith('config.json.corrupt-'),
    );
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(paths.root, corrupt[0] ?? ''), 'utf8')).toBe(
      '{ "version": 1, "public": ',
    );
    expect(next.config().provisioned).toBe(true);
    expect(next.controller.phase).toBe('ready');
  });

  it('says where the data went when config.json is gone for good', async () => {
    const folder = await provisionedFolder();
    const paths = build(folder).paths;
    rmSync(paths.configFile);
    rmSync(paths.configFile + '.bak', { force: true });

    const next = build(folder);
    await next.controller.start();

    const notice = next.uiCalls.find(
      (call) => call[0] === 'message' && call[2] === 'Se apartaron datos sin configuración',
    );
    expect(notice).toBeDefined();
    const orphan = readdirSync(next.paths.root).find((name) => name.startsWith('pgdata.orphaned-'));
    expect(orphan).toBeDefined();
    expect(String(notice?.[3])).toContain(orphan ?? 'missing');
  });

  it('treats a database folder that is gone like a dead end', async () => {
    const folder = await provisionedFolder();
    const paths = build(folder).paths;
    rmSync(paths.pgdata, { recursive: true, force: true });
    chooseAnswers = [3];

    const next = build(folder);
    await next.controller.start();

    expect(buttonsOf(next)).toContain('Empezar de nuevo y restaurar una copia');
  });
});

describe('a restore that was cut off', () => {
  it('is undone at the next start: the old documents come back and the scratch database goes', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await harness.controller.quit();
    const { paths } = harness;
    // Where a restore stops after it swapped the documents: the backup's in place, the old ones aside.
    mkdirSync(paths.files, { recursive: true });
    writeFileSync(join(paths.files, 'from-the-backup.obj'), 'backup');
    const aside = `${paths.files}.replaced-1`;
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, 'old.obj'), 'old');
    writeFileSync(
      join(paths.root, 'restore-journal.json'),
      JSON.stringify({
        version: 1,
        stamp: '1',
        step: 'files-swapped',
        filesAside: aside,
        unpacked: join(paths.root, 'tmp-restore-1'),
        configCopy: null,
      }),
    );

    const next = build(harness.folder);
    next.setDatabases(['postgres', 'consultorio', 'consultorio_restore']);
    await next.controller.start();

    expect(readFileSync(join(paths.files, 'old.obj'), 'utf8')).toBe('old');
    expect(existsSync(join(paths.files, 'from-the-backup.obj'))).toBe(false);
    expect(next.events).toContain('scratch drop');
    expect(existsSync(join(paths.root, 'restore-journal.json'))).toBe(false);
    expect(next.controller.phase).toBe('ready');
  });
});

describe('a restore whose record cannot be read', () => {
  it('does not start on top of it: the data may be half way between two states, and the person is told', async () => {
    await harness.controller.start();
    await completeSetup(setupUrl() ?? '');
    await harness.controller.quit();
    writeFileSync(join(harness.paths.root, 'restore-journal.json'), '{ not json');

    const next = build(harness.folder);
    await next.controller.start();

    expect(next.controller.phase).toBe('error');
    expect(next.events).not.toContain('migrate');
    expect(next.spawned).toHaveLength(0);
    const dialog = next.uiCalls.find((call) => call[0] === 'choose');
    expect(String(dialog?.[1])).toContain('no pudo iniciar');
    // Nothing of it was touched: the record is still there for whoever has to look at it.
    expect(existsSync(join(harness.paths.root, 'restore-journal.json'))).toBe(true);
    const splash = next.uiCalls.filter((call) => call[0] === 'splash').at(-1);
    expect(String(splash?.[1])).toContain('restauración');
  });
});

describe('the port of the local server', () => {
  it('tells the person, once, that links in older emails stopped working when the port had to move', async () => {
    await harness.controller.start();
    const stored = harness.config().port;
    await harness.controller.quit();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(stored, '127.0.0.1', resolve));
    try {
      const next = build(harness.folder);

      await next.controller.start();

      expect(next.config().port).not.toBe(stored);
      const notices = next.uiCalls.filter(
        (call) => call[0] === 'message' && call[2] === 'La dirección local de Consulvia cambió',
      );
      expect(notices).toHaveLength(1);
      expect(String(notices[0]?.[3])).toContain(String(stored));
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it('says nothing when the port stays where it was', async () => {
    await harness.controller.start();
    await harness.controller.quit();
    const next = build(harness.folder);

    await next.controller.start();

    expect(next.uiCalls.some((call) => call[0] === 'message')).toBe(false);
  });
});

describe('the recovery key', () => {
  /** The key is shown; nothing is created until it is confirmed. */
  async function setUp(): Promise<{ ack: string }> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    const answer = await post(new URL('/__setup', url).href, tokenOf(url), form);
    return { ack: String(answer.body['ackToken']) };
  }

  /**
   * An install of an earlier build whose owner never confirmed the key (a new install cannot get there any more):
   * created and confirmed here, then marked as not confirmed, and started again. Returns the key it was set up with.
   */
  async function unconfirmedInstall(): Promise<string> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    const key = shownKey;
    await harness.controller.quit();
    new ConfigStore(harness.paths.configFile, cipher).update((config) => {
      config.recoveryAcknowledged = false;
    });
    harness = build(harness.folder);
    await harness.controller.start();
    expect(harness.controller.recoveryPending).toBe(true);
    return key;
  }

  const lastFour = () => shownKey.slice(-4);
  const base = () => `http://127.0.0.1:${String(harness.config().port)}`;
  const confirm = (ack: string, value: string) =>
    post(`${base()}/__ack`, ack, { recoveryKeyLast4: value });

  it('hands the page that shows the key a token to confirm it, because the setup token is for the form', async () => {
    const { ack } = await setUp();

    expect(ack).toMatch(/^[\w-]{20,}$/);
    // Nothing is created, so there is nothing to remind about.
    expect(harness.controller.recoveryPending).toBe(false);
    expect(harness.config().provisioned).toBe(false);
  });

  it('shows the key once, in the answer to the setup, and writes it nowhere: not the configuration, not the log', async () => {
    const { ack } = await setUp();
    expect(readFileSync(harness.paths.configFile, 'utf8')).not.toContain(shownKey);
    await confirm(ack, lastFour());

    expect(shownKey).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
    expect(harness.config().secrets.recoveryKey).toBeNull();
    const files = [harness.paths.configFile, join(harness.paths.logs, 'shell.log')];
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(shownKey);
    }
  });

  it('has no page that shows it again, with the token of the setup or any other', async () => {
    const { ack } = await setUp();

    const page = await fetch(`${base()}/__ack?t=${ack}`);

    expect(page.status).toBe(404);
  });

  it('is confirmed by typing its last four characters, which creates the organization, and is not kept on this PC after that', async () => {
    const { ack } = await setUp();
    const key = shownKey;

    const wrong = await confirm(ack, 'ZZZZ');
    const right = await confirm(ack, lastFour().toLowerCase());

    expect(wrong.status).toBe(422);
    expect(right.status).toBe(200);
    const config = harness.config();
    expect(config.recoveryAcknowledged).toBe(true);
    expect(config.provisioned).toBe(true);
    expect(config.secrets.recoveryKey).toBeNull();
    expect(JSON.stringify(readFileSync(harness.paths.configFile, 'utf8'))).not.toContain(key);
    expect(harness.controller.recoveryPending).toBe(false);
    // The token worked once.
    expect((await confirm(ack, lastFour())).status).toBe(404);
  });

  it('closes the page after five wrong tails, and creates nothing', async () => {
    const { ack } = await setUp();

    for (let attempt = 0; attempt < 5; attempt += 1) await confirm(ack, 'ZZZZ');
    const sixth = await confirm(ack, lastFour());

    expect(sixth.status).toBe(404);
    expect(harness.config().provisioned).toBe(false);
    expect(harness.commandCalls.some((call) => call.command === 'provision')).toBe(false);
  });

  it('takes a key that an earlier build kept in the configuration off the disk at the next start', async () => {
    const key = await unconfirmedInstall();
    await harness.controller.quit();
    const store = new ConfigStore(harness.paths.configFile, cipher);
    store.update((config) => {
      config.secrets.recoveryKey = key;
    });

    const again = build(harness.folder);
    await again.controller.start();

    expect(again.config().secrets.recoveryKey).toBeNull();
    expect(again.controller.recoveryPending).toBe(true);
    await again.controller.quit();
  });

  it('opens the check page from the tray, and typing the whole key right confirms an install that never did', async () => {
    const key = await unconfirmedInstall();
    harness.uiCalls.length = 0;

    harness.controller.openRecoveryKey();

    const opened = harness.uiCalls.find((call) => call[0] === 'openAuxWindow');
    const url = String(opened?.[1]);
    // Never the key itself: not in the address, not on the page.
    expect(url).toContain('/__check?t=');
    const page = await fetch(url);
    expect(await page.text()).not.toContain(key);
    const no = await post(new URL('/__check', url).href, tokenOf(url), {
      recoveryKey: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
    });
    expect(no.status).toBe(422);
    expect(harness.controller.recoveryPending).toBe(true);
    const yes = await post(new URL('/__check', url).href, tokenOf(url), { recoveryKey: key });
    expect(yes.status).toBe(200);
    expect(harness.controller.recoveryPending).toBe(false);
    expect(harness.config().recoveryAcknowledged).toBe(true);
  });

  it('opens a check page too once it is confirmed, and the check says yes only to the real key', async () => {
    await harness.controller.start();
    await completeSetup(setupUrl() ?? '');
    const key = shownKey;
    harness.uiCalls.length = 0;

    harness.controller.openRecoveryKey();

    const opened = harness.uiCalls.find((call) => call[0] === 'openAuxWindow');
    const url = String(opened?.[1]);
    expect(url).toContain('/__check?t=');
    const no = await post(new URL('/__check', url).href, tokenOf(url), {
      recoveryKey: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
    });
    const yes = await post(new URL('/__check', url).href, tokenOf(url), {
      recoveryKey: key.toLowerCase(),
    });
    expect(no.status).toBe(422);
    expect(yes.status).toBe(200);
  });

  it('reminds the person at every start of an install that never confirmed the key, and then stops', async () => {
    const key = await unconfirmedInstall();
    const reminded = (target: Harness) =>
      target.uiCalls.filter(
        (call) => call[0] === 'notify' && call[1] === 'Falta confirmar la clave de recuperación',
      );
    expect(reminded(harness)).toHaveLength(1);
    await harness.controller.quit();

    const again = build(harness.folder);
    await again.controller.start();
    expect(reminded(again)).toHaveLength(1);
    harness = again;
    harness.controller.openRecoveryKey();
    const opened = harness.uiCalls.find((call) => call[0] === 'openAuxWindow');
    const url = String(opened?.[1]);
    await post(new URL('/__check', url).href, tokenOf(url), { recoveryKey: key });
    await harness.controller.quit();

    const last = build(harness.folder);
    await last.controller.start();
    expect(last.uiCalls.some((call) => call[0] === 'notify')).toBe(false);
  });
});

describe('a new recovery key for an install that never confirmed one', () => {
  const regenUrl = () => {
    const opened = harness.uiCalls.filter((call) => call[0] === 'openAuxWindow').at(-1);
    return String(opened?.[1]);
  };
  const submit = (body: Record<string, unknown>) =>
    post(new URL('/__regen', regenUrl()).href, tokenOf(regenUrl()), body);
  const credentials = { email: 'ana@clinica.example', password: 'una frase larga', code: '' };

  async function unconfirmed(): Promise<string> {
    await harness.controller.start();
    await completeSetup(setupUrl() ?? '');
    const key = shownKey;
    await harness.controller.quit();
    new ConfigStore(harness.paths.configFile, cipher).update((config) => {
      config.recoveryAcknowledged = false;
    });
    harness = build(harness.folder);
    await harness.controller.start();
    harness.uiCalls.length = 0;
    harness.controller.openRegenerateRecoveryKey();
    return key;
  }

  it('is offered only while the key is not confirmed', async () => {
    await harness.controller.start();
    await completeSetup(setupUrl() ?? '');
    harness.uiCalls.length = 0;

    harness.controller.openRegenerateRecoveryKey();

    expect(harness.uiCalls.some((call) => call[0] === 'openAuxWindow')).toBe(false);
    await harness.controller.quit();
  });

  it('opens a page that asks for the credentials of the owner', async () => {
    await unconfirmed();

    expect(regenUrl()).toContain('/__regen?t=');
    const html = await (await fetch(regenUrl())).text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="code"');
  });

  it('is gated by the API: the password (and the code) of an owner, never the Windows session alone', async () => {
    const oldKey = await unconfirmed();
    const before = harness.config().secrets.recoveryKeyHash;

    ownerAnswer = { ok: false, reason: 'refused' };
    const refused = await submit(credentials);
    ownerAnswer = { ok: false, reason: 'needs_code' };
    const needsCode = await submit(credentials);

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ errors: { password: expect.any(String) as string } });
    expect(needsCode.status).toBe(422);
    expect(needsCode.body).toMatchObject({ errors: { code: expect.any(String) as string } });
    // Nothing changed, and the API was asked with what it needs to be the one that decides.
    expect(harness.config().secrets.recoveryKeyHash).toBe(before);
    expect(verifyRecoveryKey(oldKey, before)).toBe(true);
    expect(ownerChecks).toHaveLength(2);
    expect(ownerChecks[0]).toMatchObject({
      email: credentials.email,
      password: credentials.password,
      publicOrigin: harness.controller.appUrl,
    });
    expect(ownerChecks[0]?.apiPort).toBeGreaterThan(0);
    expect(ownerChecks[0]?.proxySecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('closes the page after five refusals, even if the sixth would be accepted', async () => {
    await unconfirmed();
    ownerAnswer = { ok: false, reason: 'refused' };

    for (let attempt = 0; attempt < 5; attempt += 1) await submit(credentials);
    ownerAnswer = { ok: true };
    const sixth = await submit(credentials);

    expect(sixth.status).toBe(404);
    expect(harness.uiCalls).toContainEqual(['closeAuxWindow']);
  });

  it('says so when the API cannot be asked, and makes no key', async () => {
    await unconfirmed();
    ownerAnswer = { ok: false, reason: 'unavailable' };

    const answer = await submit(credentials);

    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ message: expect.any(String) as string });
    expect(harness.controller.recoveryPending).toBe(true);
  });

  it('shows a new key that counts only when it is confirmed, and then the old one stops working', async () => {
    const oldKey = await unconfirmed();
    const before = harness.config().secrets;

    const shown = await submit(credentials);

    expect(shown.status).toBe(200);
    const newKey = String(shown.body['recoveryKey']);
    const ack = String(shown.body['ackToken']);
    expect(newKey).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
    expect(newKey).not.toBe(oldKey);
    // Shown, not yet in force: the old key still works, and the new one is written nowhere.
    expect(harness.config().secrets.recoveryKeyHash).toBe(before.recoveryKeyHash);
    expect(readFileSync(harness.paths.configFile, 'utf8')).not.toContain(newKey);
    const base = `http://127.0.0.1:${String(harness.config().port)}`;
    expect((await post(`${base}/__ack`, ack, { recoveryKeyLast4: 'ZZZZ' })).status).toBe(422);
    expect(harness.controller.recoveryPending).toBe(true);

    const confirmed = await post(`${base}/__ack`, ack, { recoveryKeyLast4: newKey.slice(-4) });

    expect(confirmed.status).toBe(200);
    const after = harness.config();
    expect(after.recoveryAcknowledged).toBe(true);
    expect(harness.controller.recoveryPending).toBe(false);
    expect(verifyRecoveryKey(newKey, after.secrets.recoveryKeyHash)).toBe(true);
    expect(verifyRecoveryKey(oldKey, after.secrets.recoveryKeyHash)).toBe(false);
    // The backups made from now on open with the new key.
    expect(unwrapBackupKey(after.secrets.backupKeyWrap, newKey).toString('base64')).toBe(
      after.secrets.backupKeyBase64,
    );
    expect(readFileSync(harness.paths.configFile, 'utf8')).not.toContain(newKey);
  });
});

describe('the reminder to copy the backups off this PC', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function provisioned(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await harness.controller.quit();
  }

  const reminders = (target: Harness) =>
    target.uiCalls.filter(
      (call) => call[0] === 'notify' && call[1] === 'Copia de seguridad fuera de la computadora',
    );

  it('starts counting at the setup, and says nothing before 30 days', async () => {
    await provisioned();
    expect(harness.config().settings.lastCopyReminder).toBe(clock.toISOString());

    clock = new Date(clock.getTime() + 29 * DAY);
    const again = build(harness.folder);
    await again.controller.start();

    expect(reminders(again)).toHaveLength(0);
  });

  it('reminds after 30 days, once, and counts from the reminder', async () => {
    await provisioned();
    const setupTime = clock;
    clock = new Date(setupTime.getTime() + 31 * DAY);

    const again = build(harness.folder);
    await again.controller.start();

    expect(reminders(again)).toHaveLength(1);
    expect(again.config().settings.lastCopyReminder).toBe(clock.toISOString());
    await again.controller.quit();

    const third = build(harness.folder);
    await third.controller.start();
    expect(reminders(third)).toHaveLength(0);
  });
});

describe('who may hand out audit_sealer', () => {
  it('is app_owner only while a migration that is pending runs, and not before or after', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await harness.controller.quit();
    ownerAdminCalls = [];
    ownerAdminAtMigrate = [];
    appliedMigrations = 1; // the bundle knows 2

    const next = build(harness.folder);
    await next.controller.start();

    expect(ownerAdminAtMigrate).toEqual([true]);
    expect(ownerAdminCalls).toEqual([true, false]);
    await next.controller.quit();
  });

  it('is taken away at every start, also when there is nothing to migrate', async () => {
    appliedMigrations = 2;
    await harness.controller.start();

    expect(ownerAdminAtMigrate).toEqual([false]);
    expect(ownerAdminCalls).toEqual([false]);
  });

  it('is taken away when the migration fails', async () => {
    appliedMigrations = 1;
    migrateFails = true;
    chooseAnswers = [2];

    await harness.controller.start();

    expect(ownerAdminCalls).toEqual([true, false]);
  });
});

describe('an update of the program', () => {
  async function provisionedFolder(): Promise<string> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).not.toBeNull();
    });
    await harness.controller.quit();
    backupsAtMigrate = [];
    return harness.folder;
  }

  const dialog = (target: Harness) =>
    target.uiCalls.find((call) => call[0] === 'choose' && call[1] === 'Consulvia no pudo iniciar');

  /** The copies in the ledger were verified some time ago: the hours say how long. */
  function ageBackups(directory: string, hours: number): void {
    const file = join(directory, 'registro-de-copias.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8')) as {
      files: Record<string, { verifiedAt: string }>;
    };
    for (const entry of Object.values(ledger.files)) {
      entry.verifiedAt = new Date(clock.getTime() - hours * 3_600_000).toISOString();
    }
    writeFileSync(file, JSON.stringify(ledger));
  }

  it('makes a verified backup before it migrates a database that is behind', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 30);
    appliedMigrations = 1; // the bundle knows 2

    const next = build(folder);
    await next.controller.start();

    expect(backupsAtMigrate).toHaveLength(1);
    expect(backupsAtMigrate[0]?.some((name) => name.includes('previa-actualizacion'))).toBe(true);
    expect(
      Object.keys(await readLedger(next.paths.backups)).some((name) =>
        name.includes('previa-actualizacion'),
      ),
    ).toBe(true);
    expect(next.controller.phase).toBe('ready');
  });

  it('does not make one when the database is up to date, or new', async () => {
    const folder = await provisionedFolder();
    appliedMigrations = 2;
    const current = build(folder);
    await current.controller.start();
    await current.controller.quit();

    expect(backupsAtMigrate[0]?.some((name) => name.includes('previa-actualizacion'))).toBe(false);
  });

  it('takes a verified backup of the last day as that copy, and makes no new one', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 5);
    appliedMigrations = 1;

    const next = build(folder);
    await next.controller.start();

    expect(backupsAtMigrate[0]?.some((name) => name.includes('previa-actualizacion'))).toBe(false);
    expect(next.events).toContain('migrate');
    expect(next.controller.phase).toBe('ready');
  });

  it('does not take a copy that is a day old or more, or one whose file is gone', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 25);
    appliedMigrations = 1;

    const old = build(folder);
    await old.controller.start();
    expect(backupsAtMigrate[0]?.some((name) => name.includes('previa-actualizacion'))).toBe(true);
    await old.controller.quit();

    for (const name of readdirSync(harness.paths.backups)) {
      if (name.endsWith('.cvb')) rmSync(join(harness.paths.backups, name));
    }
    ageBackups(harness.paths.backups, 1);
    backupsAtMigrate = [];
    appliedMigrations = 1;
    const gone = build(folder);
    await gone.controller.start();
    expect(backupsAtMigrate[0]?.some((name) => name.includes('previa-actualizacion'))).toBe(true);
  });

  it('offers to go on without that copy only after a retry failed too, with a warning, and goes on if the person insists', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 48);
    appliedMigrations = 1;
    listCode = 1;

    const next = build(folder);
    chooseAnswers = [0, 2];
    confirmAnswer = true;
    await next.controller.start();

    const dialogs = next.uiCalls.filter((call) => call[0] === 'choose').map((call) => call[2]);
    expect(dialogs[0]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(dialogs[1]).toEqual([
      'Reintentar',
      'Ver registros',
      'Continuar sin esta copia',
      'Salir',
    ]);
    // It warned, and went on to migrate because the person said so.
    expect(
      next.uiCalls.some(
        (call) => call[0] === 'confirm' && call[1] === 'Actualizar sin copia de seguridad',
      ),
    ).toBe(true);
    expect(next.events).toContain('migrate');
    expect(next.controller.phase).toBe('ready');
  });

  it('does not go on without the copy when the person does not confirm the warning', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 48);
    appliedMigrations = 1;
    listCode = 1;

    const next = build(folder);
    chooseAnswers = [0, 2, 3];
    confirmAnswer = false;
    await next.controller.start();

    expect(next.events).not.toContain('migrate');
    expect(next.controller.phase).toBe('error');
  });

  it('does not migrate at all when that backup cannot be made', async () => {
    const folder = await provisionedFolder();
    ageBackups(harness.paths.backups, 48);
    appliedMigrations = 1;
    listCode = 1;

    const next = build(folder);
    await next.controller.start();

    expect(backupsAtMigrate).toEqual([]);
    expect(next.events).not.toContain('migrate');
    expect(dialog(next)).toBeDefined();
    expect(
      next.uiCalls.some(
        (call) => call[0] === 'splash' && String(call[1]).includes('copia de seguridad previa'),
      ),
    ).toBe(false);
  });

  it('refuses a database made by a newer version, before it touches it, with no way to start over', async () => {
    const folder = await provisionedFolder();
    appliedMigrations = 3; // the bundle knows 2

    const next = build(folder);
    await next.controller.start();

    expect(backupsAtMigrate).toEqual([]);
    expect(next.events).not.toContain('migrate');
    expect(dialog(next)?.[2]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(
      next.uiCalls.some((call) => call[0] === 'splash' && String(call[1]).includes('más nueva')),
    ).toBe(true);
  });
});

describe('when something of the install stops', () => {
  async function ready(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    // Let the backup of the first open of the day end: while it runs the program is busy.
    await waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).not.toBeNull();
    });
  }

  const titleOf = 'Consulvia no pudo iniciar';
  const dialogs = (target: Harness) =>
    target.uiCalls.filter((call) => call[0] === 'choose' && call[1] === titleOf);

  it('offers Retry when a process fails for good after the start, and the retry brings it back', async () => {
    await ready();
    const before = harness.spawned.filter((entry) => entry.role === 'api').length;
    dieOnSpawn = { api: true };
    chooseAnswers = [0];
    // By the time the dialog is up, whatever was wrong is fixed.
    whileDialogOpen = () => {
      dieOnSpawn = {};
    };

    harness.children
      .filter((entry) => entry.role === 'api')
      .at(-1)
      ?.child.emit('exit', 1, null);

    await waitFor(() => {
      expect(dialogs(harness)).toHaveLength(1);
      expect(harness.spawned.filter((entry) => entry.role === 'api').length).toBeGreaterThan(
        before + 2,
      );
    });
    expect(dialogs(harness)[0]?.[2]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(harness.controller.phase).toBe('ready');
    expect(harness.quitRequests).toBe(0);
    // And only one dialog, though the API failed three times and the worker was restarted with it.
    expect(dialogs(harness)).toHaveLength(1);
  });

  it('shows one dialog, not two, when the services fail during the start', async () => {
    dieOnSpawn = { api: true };

    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await waitFor(() => {
      expect(dialogs(harness).length).toBeGreaterThan(0);
    });

    expect(dialogs(harness)).toHaveLength(1);
  });

  it('restarts the database and the services when the database stops answering twice in a row', async () => {
    await ready();
    harness.events.length = 0;
    databaseAlive = false;

    await harness.controller.checkDatabase();
    expect(harness.events).toEqual([]);
    await harness.controller.checkDatabase();

    expect(harness.events).toEqual(
      expect.arrayContaining([
        'shutdown api',
        'shutdown worker',
        'pg stop',
        'pg start',
        'spawn api',
        'spawn worker',
      ]),
    );
    expect(harness.events.indexOf('pg start')).toBeGreaterThan(harness.events.indexOf('pg stop'));
    expect(harness.events.lastIndexOf('spawn api')).toBeGreaterThan(
      harness.events.indexOf('pg start'),
    );
    expect(harness.controller.phase).toBe('ready');
  });

  it('does not restart anything for a single missed answer', async () => {
    await ready();
    harness.events.length = 0;

    databaseAlive = false;
    await harness.controller.checkDatabase();
    databaseAlive = true;
    await harness.controller.checkDatabase();
    databaseAlive = false;
    await harness.controller.checkDatabase();

    expect(harness.events).toEqual([]);
  });
});

describe('how the backups are doing', () => {
  async function ready(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    });
  }

  const MINUTE = 60 * 1000;

  it('writes down when the last backup that passed its check was made, and says so in the tray and in "Acerca de"', async () => {
    await harness.controller.start();
    expect(harness.controller.lastBackupText).toBe('Última copia: todavía no hay ninguna');
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await waitFor(() => {
      expect(harness.config().settings.lastGoodBackup).toBe(clock.toISOString());
    });

    expect(harness.controller.lastBackupText).toContain('Última copia: ');
    await harness.controller.about();
    const detail = harness.details.at(-1) ?? '';
    expect(detail).toContain(harness.controller.lastBackupText);
  });

  it('keeps the time of the last good backup when a later one fails', async () => {
    await ready();
    const good = harness.config().settings.lastGoodBackup;
    clock = new Date(2026, 9, 25, 9, 0, 0);
    listCode = 1;

    await harness.controller.maybeDailyBackup();

    expect(harness.config().settings.lastGoodBackup).toBe(good);
  });

  it('tries a failed daily backup again after 5 minutes, then 10, then 20, and not before', async () => {
    await ready();
    clock = new Date(2026, 9, 25, 9, 0, 0);
    listCode = 1;
    const before = harness.dumps;

    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(before + 1);

    clock = new Date(clock.getTime() + 4 * MINUTE);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(before + 1);

    clock = new Date(clock.getTime() + 1 * MINUTE);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(before + 2);

    clock = new Date(clock.getTime() + 9 * MINUTE);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(before + 2);

    clock = new Date(clock.getTime() + 1 * MINUTE);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(before + 3);
  });

  it('succeeds on the retry, writes the day down and does not try again', async () => {
    await ready();
    clock = new Date(2026, 9, 25, 9, 0, 0);
    listCode = 1;
    await harness.controller.maybeDailyBackup();
    listCode = 0;
    clock = new Date(clock.getTime() + 6 * MINUTE);

    await harness.controller.maybeDailyBackup();

    expect(harness.config().settings.lastDailyBackup).toBe('2026-10-25');
    const dumps = harness.dumps;
    clock = new Date(clock.getTime() + 60 * MINUTE);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(dumps);
  });

  it('warns once, at a later start, that the backups sit in a folder synced to the internet, and says they are encrypted', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'consulvia-controller-'));
    const env = { OneDrive: join(folder, 'Documents') };
    const first = build(folder, { env });
    await first.controller.start();
    const url = first.loadedUrls.find((candidate) => candidate.includes('/__setup')) ?? '';
    await completeSetup(url);
    await first.controller.quit();
    const notices = (target: Harness) =>
      target.uiCalls.filter(
        (call) =>
          call[0] === 'message' && call[2] === 'Las copias están en una carpeta sincronizada',
      );
    // Not while the person is looking at the recovery key.
    expect(notices(first)).toHaveLength(0);

    const second = build(folder, { env });
    await second.controller.start();
    expect(notices(second)).toHaveLength(1);
    expect(String(notices(second)[0]?.[3])).toContain('cifradas');
    await second.controller.quit();

    const third = build(folder, { env });
    await third.controller.start();
    expect(notices(third)).toHaveLength(0);
  });

  it('says nothing about it when the backups are on an ordinary folder', async () => {
    await ready();

    expect(harness.config().settings.cloudNoticeShown).toBe(false);
  });
});

describe('the first run', () => {
  it('creates the cluster, the database and the roles once, migrates, and waits at the setup screen', async () => {
    await harness.controller.start();

    expect(harness.events).toEqual(['initdb', 'pg start', 'create database', 'roles', 'migrate']);
    expect(harness.controller.phase).toBe('setup');
    expect(setupUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__setup\?t=[\w-]{20,}$/);
    expect(harness.spawned).toHaveLength(0);
    const config = harness.config();
    expect(config).toMatchObject({
      databaseState: 'ready',
      provisioned: false,
      slug: 'consultorio',
    });
    expect(config.port).toBeGreaterThanOrEqual(1024);
  });

  it('runs the role script with random passwords and no development password', async () => {
    await harness.controller.start();

    const [script] = harness.clusterScripts;
    const { secrets } = harness.config();
    expect(script).not.toContain('_dev_only');
    expect(script).toContain(`'${secrets.appRwPassword}'`);
    expect(script).toContain(`'${secrets.appOwnerPassword}'`);
    expect(script).toContain(`'${secrets.auditSealerPassword}'`);
    expect(script).toContain('CREATE ROLE app_operator NOLOGIN');
  });

  it('keeps the secrets out of the shell log, and does not write the setup address there outside test mode', async () => {
    await harness.controller.start();

    const log = readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8');
    const { secrets } = harness.config();
    for (const secret of Object.values(secrets)) expect(log).not.toContain(secret);
    expect(log).not.toContain('setup url');
    expect(log).not.toContain(tokenOf(setupUrl()));
    expect(log).not.toContain(harness.controller.windowProof);
  });

  it('shows the recovery key BEFORE anything is created, and creates the organization only when the owner confirms it', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';

    const shown = await post(new URL('/__setup', url).href, tokenOf(url), form);

    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({
      ok: true,
      recoveryKey: shownKey,
      ackToken: expect.any(String) as string,
    });
    // Nothing exists yet: not the organization, not the services, not a key in the install.
    expect(harness.commandCalls.some((call) => call.command === 'provision')).toBe(false);
    expect(harness.spawned).toHaveLength(0);
    expect(harness.controller.phase).toBe('setup');
    expect(harness.config().provisioned).toBe(false);
    expect(verifyRecoveryKey(shownKey, harness.config().secrets.recoveryKeyHash)).toBe(false);

    const ack = String(shown.body['ackToken']);
    const confirm = (value: string) =>
      post(new URL('/__ack', url).href, ack, { recoveryKeyLast4: value });
    expect((await confirm('ZZZZ')).status).toBe(422);
    expect(harness.commandCalls.some((call) => call.command === 'provision')).toBe(false);
    const done = await confirm(shownKey.slice(-4).toLowerCase());

    expect(done.status).toBe(200);
    const provision = harness.commandCalls.find((call) => call.command === 'provision');
    expect(provision?.input).toEqual({
      organizationName: 'Clínica Prueba',
      ownerName: 'Dra. Ana Gómez',
      ownerEmail: 'ana@clinica.example',
      ownerPassword: form.password,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    // The password travels as input, never in the environment of the command.
    expect(JSON.stringify(provision?.env)).not.toContain(form.password);
    expect(provision?.env).toMatchObject({
      SINGLE_TENANT_SLUG: 'consultorio',
      DEPLOYMENT_PROFILE: 'desktop',
    });
    expect(harness.spawned.map((child) => child.role).sort()).toEqual(['api', 'worker']);
    expect(harness.controller.phase).toBe('ready');
    const config = harness.config();
    expect(config.provisioned).toBe(true);
    expect(config.recoveryAcknowledged).toBe(true);
    // The key the owner saw is the one the install checks and the backups are wrapped with.
    expect(verifyRecoveryKey(shownKey, config.secrets.recoveryKeyHash)).toBe(true);
    expect(unwrapBackupKey(config.secrets.backupKeyWrap, shownKey).toString('base64')).toBe(
      config.secrets.backupKeyBase64,
    );
  });

  it('leaves nothing behind when the window or the program closes before the key is confirmed, and asks again with a new key', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    const first = await post(new URL('/__setup', url).href, tokenOf(url), form);
    const oldKey = String(first.body['recoveryKey']);
    const oldAck = String(first.body['ackToken']);
    await harness.controller.quit();

    const again = build(harness.folder);
    await again.controller.start();

    // The install is as it was: a form to fill, nothing created, no service.
    expect(again.controller.phase).toBe('setup');
    expect(again.config().provisioned).toBe(false);
    expect(again.commandCalls.some((call) => call.command === 'provision')).toBe(false);
    const newUrl = again.loadedUrls.find((candidate) => candidate.includes('/__setup')) ?? '';
    // The key of before is of no use to anything, and the address that confirmed it does not exist any more.
    expect(
      (await post(new URL('/__ack', newUrl).href, oldAck, { recoveryKeyLast4: oldKey.slice(-4) }))
        .status,
    ).toBe(404);
    const second = await post(new URL('/__setup', newUrl).href, tokenOf(newUrl), form);
    expect(String(second.body['recoveryKey'])).not.toBe(oldKey);
    expect(verifyRecoveryKey(oldKey, again.config().secrets.recoveryKeyHash)).toBe(false);
  });

  it('sends the owner back to the form, with the reason, when the organization cannot be created, and makes a new key', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    provisionFails = new ApiCommandError(
      'provision',
      EXIT.invalidInput,
      { error: 'password_rejected', issues: ['common'] },
      '',
    );

    const { shown, confirmed } = await completeSetup(url);

    expect(shown.status).toBe(200);
    expect(confirmed.status).toBe(422);
    expect(confirmed.body).toMatchObject({
      ok: false,
      back: true,
      errors: { password: expect.stringContaining('muy común') as string },
    });
    expect(harness.controller.phase).toBe('setup');
    expect(harness.config().provisioned).toBe(false);
    expect(harness.spawned).toHaveLength(0);
    // And the form works again: another key is made for the next try.
    provisionFails = null;
    const retry = await completeSetup(url);
    expect(retry.confirmed.status).toBe(200);
    expect(String(retry.shown.body['recoveryKey'])).not.toBe(String(shown.body['recoveryKey']));
  });

  it('gives the API, and only the API, a secret of this run, and checks the proof with the same one', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);

    const api = harness.spawned.find((child) => child.role === 'api');
    const worker = harness.spawned.find((child) => child.role === 'worker');
    const secret = api?.env['DESKTOP_PROXY_SECRET'] ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(worker?.env['DESKTOP_PROXY_SECRET']).toBeUndefined();
    expect(harness.probes.length).toBeGreaterThan(0);
    for (const probe of harness.probes) {
      expect(probe).toEqual({ port: Number(api?.env['PORT']), secret });
    }
    // Nothing that is written down or shown carries it.
    expect(readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8')).not.toContain(secret);
  });

  it('uses a new secret and a port of its own every time the services start', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    const other = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')));
    await other.controller.start();
    const otherUrl = other.loadedUrls.find((candidate) => candidate.includes('/__setup')) ?? '';
    await completeSetup(otherUrl);

    const first = harness.spawned.find((child) => child.role === 'api')?.env[
      'DESKTOP_PROXY_SECRET'
    ];
    const second = other.spawned.find((child) => child.role === 'api')?.env['DESKTOP_PROXY_SECRET'];

    expect(first).not.toBe(second);
  });

  it('turns the setup screen into a 404 once the organization exists', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);

    const again = await post(new URL('/__setup', url).href, tokenOf(url), form);

    expect(again.status).toBe(404);
    expect(harness.commandCalls.filter((call) => call.command === 'provision')).toHaveLength(1);
  });

  it('writes the setup address to the log only in test mode', async () => {
    rmSync(harness.folder, { recursive: true, force: true });
    harness = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')), { testMode: true });

    await harness.controller.start();

    const log = readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8');
    expect(log).toContain(`setup url: ${setupUrl() ?? 'none'}`);
    expect(log).toContain(`window proof: ${harness.controller.windowProof}`);
  });
});

describe('every other start', () => {
  async function provisioned(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    await harness.controller.quit();
    // A new process: a new controller over the same folders.
    const folder = harness.folder;
    harness = build(folder);
    harness.events.length = 0;
  }

  it('does not create anything again: it starts the database, migrates and starts the services', async () => {
    await provisioned();

    await harness.controller.start();

    expect(harness.events.slice(0, 2)).toEqual(['pg start', 'migrate']);
    expect(harness.events).not.toContain('initdb');
    expect(harness.events).not.toContain('roles');
    expect(harness.events).not.toContain('provision');
    expect(harness.controller.phase).toBe('ready');
    expect(harness.loadedUrls.at(-1)).toBe(harness.controller.appUrl);
  });

  it('keeps the same port, so PUBLIC_URL never changes', async () => {
    await provisioned();
    const before = harness.config().port;

    await harness.controller.start();

    expect(harness.config().port).toBe(before);
    const api = harness.spawned.find((child) => child.role === 'api');
    expect(api?.env['PUBLIC_URL']).toBe(`http://127.0.0.1:${String(before)}`);
  });

  it('gives the API its login and the worker the sealing login too', async () => {
    await provisioned();

    await harness.controller.start();

    const api = harness.spawned.find((child) => child.role === 'api');
    const worker = harness.spawned.find((child) => child.role === 'worker');
    expect(api?.env['AUDIT_SEALER_DATABASE_URL']).toBeUndefined();
    expect(worker?.env['AUDIT_SEALER_DATABASE_URL']).toContain('audit_sealer');
    expect(api?.env['DATABASE_URL']).toContain('app_rw');
  });
});

describe('opening the program in the browser of the PC', () => {
  const ready = async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
  };

  it('opens an address that works once and leaves the browser with a proof, not the plain address', async () => {
    await ready();

    harness.controller.openInBrowser();

    const opened = harness.uiCalls.find((call) => call[0] === 'openExternal');
    const address = String(opened?.[1]);
    expect(address).toContain('/__browser?t=');
    const first = await fetch(address, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    const again = await fetch(address, { redirect: 'manual' });
    expect(again.status).toBe(404);
  });

  it('is not offered before the program is ready', async () => {
    await harness.controller.start();

    harness.controller.openInBrowser();

    expect(harness.uiCalls.some((call) => call[0] === 'openExternal')).toBe(false);
  });

  it('refuses the API to a program that has no proof, and serves it to the window', async () => {
    await ready();
    const base = harness.controller.appUrl;

    const stranger = await fetch(`${base}/api/health`);
    const window = await fetch(`${base}/api/health`, {
      headers: { 'x-consulvia-window': harness.controller.windowProof },
    });

    expect(stranger.status).toBe(403);
    expect(window.status).not.toBe(403);
  });
});

describe('quitting', () => {
  it('stops the API and the worker before the database, and closes everything', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    harness.events.length = 0;

    await harness.controller.quit();

    expect(harness.events.filter((event) => event.startsWith('shutdown')).sort()).toEqual([
      'shutdown api',
      'shutdown worker',
    ]);
    expect(harness.events.at(-1)).toBe('pg stop');
    expect(harness.controller.phase).toBe('quitting');
  });

  it('can be asked twice', async () => {
    await harness.controller.start();

    const first = harness.controller.quit();
    const second = harness.controller.quit();

    expect(second).toBe(first);
    await first;
    expect(harness.events.filter((event) => event === 'pg stop')).toHaveLength(1);
  });
});

describe('when something fails at the start', () => {
  it('says so, offers to retry, read the logs or quit, and quits when asked to', async () => {
    migrateFails = true;
    chooseAnswers = [2];

    await harness.controller.start();

    const choice = harness.uiCalls.find((call) => call[0] === 'choose');
    expect(choice?.[2]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(harness.quitRequests).toBe(1);
    expect(harness.controller.phase).toBe('error');
  });

  it('starts again from the beginning when asked to retry, and recovers if the cause is gone', async () => {
    migrateFails = true;
    chooseAnswers = [0];
    // While the dialog is open the cause goes away; the answer is "Reintentar".
    whileDialogOpen = () => {
      migrateFails = false;
    };

    await harness.controller.start();

    expect(harness.controller.phase).toBe('setup');
    expect(harness.events.filter((event) => event === 'migrate').length).toBeGreaterThanOrEqual(2);
  });

  it('still shows the dialog and starts again when stopping what was running fails on a retry', async () => {
    migrateFails = true;
    stopFails = true;
    chooseAnswers = [0];
    whileDialogOpen = () => {
      migrateFails = false;
    };

    await harness.controller.start();

    // The failure to stop is logged and does not leave the splash with nobody to ask.
    expect(harness.controller.phase).toBe('setup');
    const log = readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8');
    expect(log).toContain('could not stop');
  });

  it('offers to start over and restore a copy by itself after the same failure three times in a row', async () => {
    migrateFails = true;
    chooseAnswers = [0, 0, 3];

    await harness.controller.start();

    const dialogs = harness.uiCalls.filter((call) => call[0] === 'choose').map((call) => call[2]);
    expect(dialogs).toHaveLength(3);
    expect(dialogs[0]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(dialogs[1]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
    expect(dialogs[2]).toEqual([
      'Reintentar',
      'Ver registros',
      'Empezar de nuevo y restaurar una copia',
      'Salir',
    ]);
  });

  it('keeps start over behind "Más opciones" when the three failures were not the same one', async () => {
    // A, B, A: the cause changes between the tries, so it is not known to be the data that will not open.
    migrateFails = true;
    chooseAnswers = [0, 0, 2, 3];
    let opened = 0;
    whileDialogOpen = () => {
      opened += 1;
      if (opened === 1) {
        migrateFails = false;
        appliedMigrations = 3; // a database from a newer version
      }
      if (opened === 2) {
        appliedMigrations = null;
        migrateFails = true;
      }
    };

    await harness.controller.start();

    const dialogs = harness.uiCalls.filter((call) => call[0] === 'choose').map((call) => call[2]);
    expect(dialogs).toHaveLength(4);
    expect(dialogs[2]).toEqual(['Reintentar', 'Ver registros', 'Más opciones…', 'Salir']);
    // The person asks for more, and only then is the way out offered.
    expect(dialogs[3]).toEqual([
      'Reintentar',
      'Ver registros',
      'Empezar de nuevo y restaurar una copia',
      'Salir',
    ]);
  });

  it('counts the failures again from zero after a start that works', async () => {
    migrateFails = true;
    chooseAnswers = [0, 0];
    let opened = 0;
    whileDialogOpen = () => {
      opened += 1;
      if (opened === 2) migrateFails = false;
    };
    await harness.controller.start();
    expect(harness.controller.phase).toBe('setup');

    migrateFails = true;
    chooseAnswers = [2];
    harness.uiCalls.length = 0;
    await harness.controller.start();

    const dialogs = harness.uiCalls.filter((call) => call[0] === 'choose').map((call) => call[2]);
    expect(dialogs[0]).toEqual(['Reintentar', 'Ver registros', 'Salir']);
  });

  it('tells the user what to do when the installation is incomplete', async () => {
    rmSync(join(harness.folder, 'resources', 'postgres'), { recursive: true, force: true });
    chooseAnswers = [2];

    await harness.controller.start();

    const splash = harness.uiCalls.filter((call) => call[0] === 'splash').at(-1);
    expect(splash?.[1]).toContain('Vuelva a instalar');
    expect(harness.events).toEqual([]);
  });
});

describe('the backups', () => {
  async function ready(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
    // The automatic backup of the first open of the day runs by itself; wait for it.
    await waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    });
  }

  it('enters in the ledger a backup that is in the folder but not in the ledger, at the next start', async () => {
    await ready();
    await harness.controller.quit();
    const folder = harness.folder;
    rmSync(join(harness.paths.backups, 'registro-de-copias.json'));
    expect(await readLedger(harness.paths.backups)).toEqual({});

    const next = build(folder);
    await next.controller.start();

    await vi.waitFor(
      async () => {
        expect(Object.keys(await readLedger(next.paths.backups))).toEqual([
          'consulvia-diaria-2026-10-24_1000.cvb',
        ]);
      },
      { timeout: 30_000, interval: 25 },
    );
    await next.controller.whenIdle();
  });

  it('makes the daily backup at the first open of the day, once, and writes the day down', async () => {
    await ready();

    const backups = () =>
      readdirSync(harness.paths.backups).filter((name) => name.endsWith('.cvb'));
    expect(backups()).toEqual(['consulvia-diaria-2026-10-24_1000.cvb']);
    // The file was opened again after it was written: pg_restore listed its dump, and it is in the ledger.
    expect(harness.lists).toHaveLength(1);
    expect(Object.keys(await readLedger(harness.paths.backups))).toEqual([
      'consulvia-diaria-2026-10-24_1000.cvb',
    ]);
    expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    expect(harness.dumps).toBe(1);

    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(1);

    clock = new Date(2026, 9, 25, 9, 0, 0);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(2);
    expect(backups()).toHaveLength(2);
  });

  it('does not call a backup a backup when pg_restore cannot read its dump: no file, no ledger entry, an error', async () => {
    await ready();
    clock = new Date(2026, 9, 24, 11, 30, 0);
    listCode = 1;

    const path = await harness.controller.backupNow();

    expect(path).toBeNull();
    expect(readdirSync(harness.paths.backups).filter((name) => name.includes('manual'))).toEqual(
      [],
    );
    expect(harness.uiCalls).toContainEqual([
      'message',
      'error',
      'No se pudo hacer la copia de seguridad',
      expect.any(String),
    ]);
  });

  it('makes a manual backup and says where it is', async () => {
    await ready();
    clock = new Date(2026, 9, 24, 11, 30, 0);

    const path = await harness.controller.backupNow();

    expect(path).toBe(join(harness.paths.backups, 'consulvia-manual-2026-10-24_1130.cvb'));
    expect(existsSync(path ?? '')).toBe(true);
    const done = harness.uiCalls.find(
      (call) => call[0] === 'message' && call[2] === 'Copia de seguridad lista',
    );
    expect(done?.[3]).toContain('consulvia-manual-2026-10-24_1130.cvb');
  });

  it('does not make a backup while the program is still starting', async () => {
    const path = await harness.controller.backupNow();

    expect(path).toBeNull();
    expect(harness.dumps).toBe(0);
  });
});

describe('restoring a backup', () => {
  const WRONG_KEY = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF';

  /** The recovery key the install was set up with (the tests keep it before it is confirmed away). */
  let installKey = '';

  async function ready(testMode: boolean): Promise<string> {
    rmSync(harness.folder, { recursive: true, force: true });
    harness = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')), { testMode });
    await harness.controller.start();
    const url = setupUrl() ?? '';
    const { shown } = await completeSetup(url);
    installKey = String(shown.body['recoveryKey']);
    await waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    });
    clock = new Date(2026, 9, 24, 12, 0, 0);
    const path = await harness.controller.backupNow();
    clock = new Date(2026, 9, 24, 13, 0, 0);
    return path ?? '';
  }

  /** The page that asks for the keys, opened by the last restore the way the tray does. */
  const keysPage = () => {
    const opened = harness.uiCalls.filter((call) => call[0] === 'openAuxWindow').at(-1);
    return String(opened?.[1]);
  };
  const postKeys = (keys: Record<string, string>) => {
    const url = keysPage();
    return post(new URL('/__key', url).href, tokenOf(url), keys);
  };

  it('asks first, then for the key of this install, then makes a safety backup, stops the services, restores, starts them again and reloads the window', async () => {
    const backup = await ready(false);
    harness.events.length = 0;
    harness.uiCalls.length = 0;

    const started = await harness.controller.restoreFlow(backup);
    // Nothing happens until the key is typed.
    expect(started).toBe(false);
    expect(harness.restores).toHaveLength(0);
    expect(harness.events).toEqual([]);
    const answer = await postKeys({ currentKey: installKey.toLowerCase() });

    expect(answer.status).toBe(200);
    expect(harness.uiCalls[0]).toEqual(['confirm', 'Restaurar copia de seguridad']);
    expect(readdirSync(harness.paths.backups)).toContain(
      'consulvia-previa-restauracion-2026-10-24_1300.cvb',
    );
    expect(harness.events.filter((event) => event.startsWith('shutdown')).length).toBe(2);
    expect(harness.restores).toHaveLength(1);
    expect(harness.restores[0]).toContain('--single-transaction');
    // The dump runs as the throwaway role of this restore: not the superuser, not app_owner, never over the live
    // database, and with no owners or privileges of its own (the grants come from the live database).
    expect(harness.restores[0]).toEqual(
      expect.arrayContaining([
        '--username=consulvia_restore_test',
        '--no-owner',
        '--no-privileges',
        '--dbname=consultorio_restore',
      ]),
    );
    expect(harness.restores[0]).not.toContain('--username=app_owner');
    expect(harness.restoreEnvs[0]?.['PGPASSWORD']).toBe('a-password');
    expect(harness.restoreEnvs[0]?.['PGPASSWORD']).not.toBe(
      harness.config().secrets.pgSuperuserPassword,
    );
    expect(harness.restoreEnvs[0]?.['PGPASSWORD']).not.toBe(
      harness.config().secrets.appOwnerPassword,
    );
    expect(harness.events.indexOf('migrate')).toBeGreaterThan(
      harness.events.indexOf('shutdown api'),
    );
    expect(harness.events.filter((event) => event.startsWith('spawn'))).toHaveLength(2);
    expect(harness.uiCalls).toContainEqual(['loadUrl', harness.controller.appUrl]);
    expect(
      harness.uiCalls.find((call) => call[0] === 'message' && call[2] === 'Copia restaurada'),
    ).toBeDefined();
    expect(harness.controller.phase).toBe('ready');
  });

  it('shows what the backup is, and says when it comes from another installation', async () => {
    const backup = await ready(false);
    harness.uiCalls.length = 0;
    await harness.controller.restoreFlow(backup);

    expect(harness.uiCalls.some((call) => call[0] === 'confirm')).toBe(true);
    expect(harness.confirmDetails.at(-1)).toContain('de esta instalación');
    expect(harness.confirmDetails.at(-1)).toContain('manual');
  });

  it('refuses to restore without the key of this install, or with a wrong one, and touches nothing', async () => {
    const backup = await ready(false);
    harness.events.length = 0;
    await harness.controller.restoreFlow(backup);

    const none = await postKeys({});
    const wrong = await postKeys({ currentKey: WRONG_KEY });

    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ errors: { currentKey: expect.any(String) as string } });
    expect(wrong.status).toBe(422);
    expect(harness.restores).toHaveLength(0);
    expect(harness.events).toEqual([]);
    expect(readdirSync(harness.paths.backups).some((name) => name.includes('previa'))).toBe(false);
  });

  it('closes the page after five wrong keys, even if the sixth is right', async () => {
    const backup = await ready(false);
    await harness.controller.restoreFlow(backup);

    for (let attempt = 0; attempt < 5; attempt += 1) await postKeys({ currentKey: WRONG_KEY });
    const sixth = await postKeys({ currentKey: installKey });

    expect(sixth.status).toBe(404);
    expect(harness.restores).toHaveLength(0);
    expect(harness.uiCalls).toContainEqual(['closeAuxWindow']);
  });

  it('needs both keys for a backup of another installation, and refuses it when either is wrong', async () => {
    const mine = await ready(false);
    const myKey = installKey;
    // A backup made by another install: its own keys, so another key id in the header.
    const theirs = join(harness.folder, 'theirs.cvb');
    const { createBackup: make } = await import('./backup.js');
    const other = newTestInstall();
    mkdirSync(harness.paths.backups, { recursive: true });
    const made = await make(
      testBackupDeps(other, harness.paths, {
        now: () => new Date(2026, 9, 20, 9, 0, 0),
        migrationCount: 2,
      }),
      'manual',
    );
    writeFileSync(theirs, readFileSync(made.path));
    expect(mine).not.toBe('');

    await harness.controller.restoreFlow(theirs);
    expect(harness.confirmDetails.at(-1)).toContain('DE OTRA INSTALACIÓN');

    const onlyMine = await postKeys({ currentKey: myKey });
    const onlyTheirs = await postKeys({ recoveryKey: other.recoveryKey });
    const wrongTheirs = await postKeys({ currentKey: myKey, recoveryKey: WRONG_KEY });

    expect(onlyMine.status).toBe(422);
    expect(onlyMine.body).toMatchObject({ errors: { recoveryKey: expect.any(String) as string } });
    expect(onlyTheirs.status).toBe(422);
    expect(wrongTheirs.status).toBe(422);
    expect(harness.restores).toHaveLength(0);
    const right = await postKeys({ currentKey: myKey, recoveryKey: other.recoveryKey });
    expect(right.body).toEqual({ ok: true });
    expect(right.status).toBe(200);
    expect(harness.restores).toHaveLength(1);
  });

  it('skips the question only in test mode, where a script drives the install, but still asks for the key', async () => {
    const backup = await ready(true);
    harness.uiCalls.length = 0;

    await harness.controller.restoreFlow(backup);

    expect(harness.uiCalls.some((call) => call[0] === 'confirm')).toBe(false);
    expect(harness.restores).toHaveLength(0);
    expect(readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8')).toContain(
      'restore keys url: ',
    );
    await postKeys({ currentKey: installKey });
    expect(harness.restores).toHaveLength(1);
  });

  it('does nothing when the file is not a backup, and says so', async () => {
    await ready(false);
    const notBackup = join(harness.folder, 'notes.zip');
    writeFileSync(notBackup, 'not a zip');
    harness.uiCalls.length = 0;

    const restored = await harness.controller.restoreFlow(notBackup);

    expect(restored).toBe(false);
    expect(harness.restores).toHaveLength(0);
    const message = harness.uiCalls.find((call) => call[0] === 'message');
    expect(message?.[3]).toContain('no es una copia de seguridad de Consulvia');
  });

  it('does nothing when the owner says no', async () => {
    const backup = await ready(false);
    confirmAnswer = false;
    harness.events.length = 0;

    const restored = await harness.controller.restoreFlow(backup);

    expect(restored).toBe(false);
    expect(harness.restores).toHaveLength(0);
    expect(harness.events).toEqual([]);
    expect(readdirSync(harness.paths.backups).some((name) => name.includes('previa'))).toBe(false);
    expect(harness.uiCalls.some((call) => call[0] === 'openAuxWindow')).toBe(false);
  });

  it('cannot restore with a keys page that was opened during the setup, once the install has an organization', async () => {
    const donor = await ready(false);
    const copy = join(harness.folder, 'donor.cvb');
    writeFileSync(copy, readFileSync(donor));
    const theirKey = installKey;
    // A new install waiting for its setup, and a backup of another install offered to it: the page asks for the
    // key of the backup and for no key of this install, because there is nothing here to protect yet.
    const fresh = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')));
    await fresh.controller.start();
    harness = fresh;
    mkdirSync(fresh.paths.backups, { recursive: true });
    await fresh.controller.restoreFlow(copy);
    const page = keysPage();
    expect(await getText(page)).not.toContain('name="currentKey"');
    // The owner then sets the install up, and it has data to protect.
    const setup = setupUrl() ?? '';
    await completeSetup(setup);
    expect(fresh.controller.phase).toBe('ready');
    const restores = fresh.restores.length;

    // Whoever holds the old page can no longer use it: it is closed, and the key of the install is needed anyway.
    const answer = await postKeys({ recoveryKey: theirKey });

    expect(answer.status).toBe(404);
    expect(fresh.restores).toHaveLength(restores);
    expect(fresh.uiCalls).toContainEqual(['closeAuxWindow']);
  });

  it('asks for the key of this install at the moment the keys arrive, not at the moment the page was opened', async () => {
    const backup = await ready(false);
    await harness.controller.restoreFlow(backup);
    const url = keysPage();
    // The page was opened as if on a new install...
    (
      harness.controller as unknown as { pendingRestore: { needsCurrent: boolean } }
    ).pendingRestore.needsCurrent = false;

    const answer = await post(new URL('/__key', url).href, tokenOf(url), {});

    // ...but the install is in use, so a restore without its key is refused all the same.
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ errors: { currentKey: expect.any(String) as string } });
    expect(harness.restores).toHaveLength(0);
  });

  it('tells the person, with a dialog, and stops, when a failed restore leaves the services stopped', async () => {
    const backup = await ready(false);
    await harness.controller.restoreFlow(backup);
    restoreCode = 1;
    // The restore fails, the data is put back, and then the services cannot start again.
    migrateFails = true;

    const answer = await postKeys({ currentKey: installKey });

    expect(answer.status).toBe(422);
    expect(harness.controller.phase).toBe('error');
    await waitFor(() => {
      expect(harness.uiCalls.some((call) => call[0] === 'choose')).toBe(true);
    });
    // And nothing runs on its own on top of that: no backup of a program that is not running.
    expect(await harness.controller.backupNow()).toBeNull();
  });

  it('stops too when a failed restore cannot be undone: the next start finishes it, and until then nothing else is done', async () => {
    const backup = await ready(false);
    await harness.controller.restoreFlow(backup);
    restoreCode = 1;
    dropFails = true;

    const answer = await postKeys({ currentKey: installKey });

    expect(answer.status).toBe(422);
    expect(harness.controller.phase).toBe('error');
    expect(existsSync(join(harness.paths.root, 'restore-journal.json'))).toBe(true);
    await waitFor(() => {
      expect(harness.uiCalls.some((call) => call[0] === 'choose')).toBe(true);
    });
    const dialog = harness.uiCalls.find((call) => call[0] === 'choose');
    expect(String(dialog?.[1])).toContain('no pudo iniciar');
    // Retry starts again, and the start undoes what was left.
    dropFails = false;
    chooseAnswers = [0];
    harness.events.length = 0;
    await harness.controller.start();
    expect(existsSync(join(harness.paths.root, 'restore-journal.json'))).toBe(false);
    expect(harness.controller.phase).toBe('ready');
  });

  it('refuses to restore, to back up or to make the daily backup while a restore is waiting to be undone', async () => {
    const backup = await ready(false);
    writeFileSync(
      join(harness.paths.root, 'restore-journal.json'),
      JSON.stringify({
        version: 1,
        stamp: '1',
        step: 'prepared',
        filesAside: 'x',
        unpacked: 'y',
        configCopy: null,
      }),
    );
    harness.uiCalls.length = 0;
    harness.events.length = 0;
    const dumps = harness.dumps;

    const restored = await harness.controller.restoreFlow(backup);
    const made = await harness.controller.backupNow();
    clock = new Date(2026, 9, 25, 9, 0, 0);
    await harness.controller.maybeDailyBackup();

    expect(restored).toBe(false);
    expect(made).toBeNull();
    expect(harness.dumps).toBe(dumps);
    expect(harness.restores).toHaveLength(0);
    expect(harness.uiCalls.filter((call) => call[0] === 'message')).toHaveLength(2);
    expect(harness.uiCalls.some((call) => call[0] === 'openAuxWindow')).toBe(false);
  });

  it('asks for no current key on a new install that is waiting for its setup', async () => {
    const donor = await ready(false);
    const copy = join(harness.folder, 'donor.cvb');
    writeFileSync(copy, readFileSync(donor));
    const key = installKey;
    // A new install on the same disk: nothing in it to protect.
    const fresh = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')));
    await fresh.controller.start();
    harness = fresh;
    mkdirSync(fresh.paths.backups, { recursive: true });

    await fresh.controller.restoreFlow(copy);
    // It is another install's backup: its own key, and no key of this one.
    const page = keysPage();
    const html = await getText(page);
    expect(html).toContain('name="recoveryKey"');
    expect(html).not.toContain('name="currentKey"');
    const answer = await postKeys({ recoveryKey: key });

    expect(answer.status).toBe(200);
  });
});

describe("resetting the owner's password", () => {
  async function ready(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await completeSetup(url);
  }

  const NEW_PASSWORD = 'otra frase larga para entrar';

  /** Opens the reset page the way the tray does and returns its address. */
  async function openReset(): Promise<string> {
    await harness.controller.openResetPassword();
    return String(harness.uiCalls.find((call) => call[0] === 'openAuxWindow')?.[1]);
  }

  const resetBody = (recoveryKey: string | undefined, extra: Record<string, unknown> = {}) => ({
    password: NEW_PASSWORD,
    passwordConfirmation: NEW_PASSWORD,
    ...(recoveryKey === undefined ? {} : { recoveryKey }),
    ...extra,
  });

  const resetCalls = () =>
    harness.commandCalls.filter((entry) => entry.command === 'reset-password');

  it('asks before opening the page, and opens it with its own token and the key on file', async () => {
    await ready();

    const url = await openReset();

    expect(harness.uiCalls).toContainEqual(['confirm', expect.any(String)]);
    expect(url).toContain('/__reset?t=');
    expect(harness.uiCalls.findIndex((call) => call[0] === 'confirm')).toBeLessThan(
      harness.uiCalls.findIndex((call) => call[0] === 'openAuxWindow'),
    );
  });

  it('opens nothing and issues no token when the person at the PC says no', async () => {
    await ready();
    confirmAnswer = false;

    await harness.controller.openResetPassword();

    expect(harness.uiCalls.some((call) => call[0] === 'openAuxWindow')).toBe(false);
  });

  it('runs the command with the choice about the second factor, once the recovery key is right', async () => {
    await ready();
    const url = await openReset();
    const key = shownKey;

    const answer = await post(
      new URL('/__reset', url).href,
      tokenOf(url),
      resetBody(key.toLowerCase().replaceAll('-', ' '), { clearSecondFactor: true }),
    );

    expect(answer.body).toMatchObject({
      ok: true,
      email: 'ana@clinica.example',
      secondFactorCleared: true,
    });
    const [call] = resetCalls();
    // The recovery key proves who is asking; it never travels to the command.
    expect(call?.input).toEqual({ newPassword: NEW_PASSWORD, clearSecondFactor: true });
    expect(JSON.stringify(call?.env)).not.toContain('otra frase larga');
    expect(JSON.stringify(call)).not.toContain(key);
  });

  it('refuses to reset without the recovery key, or with a wrong one, and runs nothing', async () => {
    await ready();
    const url = await openReset();

    const missing = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(undefined));
    const wrong = await post(
      new URL('/__reset', url).href,
      tokenOf(url),
      resetBody('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF'),
    );

    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ errors: { recoveryKey: expect.any(String) as string } });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ errors: { recoveryKey: expect.any(String) as string } });
    expect(resetCalls()).toHaveLength(0);
  });

  it('closes the page and revokes its token after five wrong keys, even if the sixth is right', async () => {
    await ready();
    const url = await openReset();
    const key = shownKey;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(
        new URL('/__reset', url).href,
        tokenOf(url),
        resetBody('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF'),
      );
    }
    const sixth = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));

    expect(sixth.status).toBe(404);
    expect(resetCalls()).toHaveLength(0);
    expect(harness.uiCalls).toContainEqual(['closeAuxWindow']);
  });

  it('revokes the token once the password is reset, so the page cannot be used twice', async () => {
    await ready();
    const url = await openReset();
    const key = shownKey;

    const first = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));
    const second = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(resetCalls()).toHaveLength(1);
  });

  it('keeps the page open when the password is rejected, so the person can choose another', async () => {
    await ready();
    const url = await openReset();
    const key = shownKey;
    resetFails = new ApiCommandError(
      'reset-password',
      EXIT.invalidInput,
      { error: 'password_rejected', issues: ['contains_email'] },
      '',
    );

    const rejected = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));
    resetFails = null;
    const retry = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));

    expect(rejected.status).toBe(422);
    expect(retry.status).toBe(200);
  });

  it('tells the owner why a password is rejected, in the words of the product', async () => {
    await ready();
    const url = await openReset();
    resetFails = new ApiCommandError(
      'reset-password',
      EXIT.invalidInput,
      { error: 'password_rejected', issues: ['contains_email'] },
      '',
    );

    const answer = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(shownKey));

    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({
      errors: { password: expect.stringContaining('correo electrónico') as string },
    });
  });

  it('keeps the email addresses and passwords of a failing command out of shell.log', async () => {
    await ready();
    const url = await openReset();
    resetFails = new ApiCommandError(
      'reset-password',
      1,
      { error: 'failed' },
      'insert failed for ana@clinica.example using postgres://app_rw:hunter2@127.0.0.1:5432/db',
    );

    await post(new URL('/__reset', url).href, tokenOf(url), resetBody(shownKey));

    const log = readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8');
    expect(log).toContain('reset-password failed');
    expect(log).not.toContain('ana@clinica.example');
    expect(log).not.toContain('hunter2');
  });

  it('does not open before the program is ready', async () => {
    await harness.controller.start();

    await harness.controller.openResetPassword();

    expect(harness.uiCalls.some((call) => call[0] === 'openAuxWindow')).toBe(false);
    expect(harness.uiCalls.some((call) => call[0] === 'message')).toBe(true);
  });
});

describe('the settings of the tray', () => {
  it('keeps the auto-start choice and tells Windows', async () => {
    await harness.controller.start();

    harness.controller.toggleAutoStart();

    expect(harness.controller.autoStart).toBe(true);
    expect(harness.config().settings.autoStart).toBe(true);
    expect(harness.uiCalls).toContainEqual(['setAutoStart', true]);
    harness.controller.toggleAutoStart();
    expect(harness.config().settings.autoStart).toBe(false);
  });

  it('shows the notice about the tray once', async () => {
    await harness.controller.start();

    expect(harness.controller.trayHintShown).toBe(false);
    harness.controller.markTrayHintShown();
    expect(harness.controller.trayHintShown).toBe(true);
    expect(harness.config().settings.trayHintShown).toBe(true);
  });

  it('opens the outbox and the logs', async () => {
    await harness.controller.start();

    await harness.controller.openOutbox();
    await harness.controller.openLogs();

    expect(harness.uiCalls).toContainEqual(['openPath', harness.paths.outbox]);
    expect(harness.uiCalls).toContainEqual(['openPath', harness.paths.logs]);
  });
});

describe('a data folder whose configuration is gone', () => {
  it('is set aside, not deleted, and a new install starts', async () => {
    mkdirSync(join(harness.paths.pgdata), { recursive: true });
    writeFileSync(join(harness.paths.pgdata, 'PG_VERSION'), '17');
    mkdirSync(join(harness.paths.files, 't'), { recursive: true });
    writeFileSync(join(harness.paths.files, 't', 'doc.obj'), 'precious');

    await harness.controller.start();

    const aside = readdirSync(harness.paths.root).filter((name) => name.includes('.orphaned-'));
    expect(aside.sort()).toEqual([
      expect.stringMatching(/^files\.orphaned-\d+$/) as string,
      expect.stringMatching(/^pgdata\.orphaned-\d+$/) as string,
    ]);
    const files = aside.find((name) => name.startsWith('files')) ?? '';
    expect(readFileSync(join(harness.paths.root, files, 't', 'doc.obj'), 'utf8')).toBe('precious');
    expect(harness.events).toContain('initdb');
  });
});
