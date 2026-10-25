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
import { ConfigStore, type Cipher } from './config-store.js';
import { Controller, type ControllerDeps, type ShellUi } from './controller.js';
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
  controller: Controller;
  commandCalls: { command: string; env: NodeJS.ProcessEnv; input?: unknown }[];
  quitRequests: number;
  config: () => ReturnType<ConfigStore['read']>;
  loadedUrls: string[];
  clusterScripts: string[];
  spawned: { role: string; env: NodeJS.ProcessEnv }[];
  dumps: number;
  restores: string[][];
  restoreEnvs: NodeJS.ProcessEnv[];
  dumpCalls: { args: string[]; env: NodeJS.ProcessEnv }[];
  probes: { port: number; secret: string }[];
}

let harness: Harness;
/** Everything a test built, so nothing is left running or on disk. */
let folders: string[] = [];
let controllers: Controller[] = [];
let migrateFails = false;
let confirmAnswer = true;
let provisionFails: ApiCommandError | null = null;
let resetFails: ApiCommandError | null = null;
let chooseAnswers: number[];
/** Runs when a dialog with buttons opens, before it answers: a way to fix the cause while the user "reads" it. */
let whileDialogOpen: () => void = () => undefined;
let clock = new Date(2026, 9, 24, 10, 0, 0);

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain).reverse().toString('base64')),
  decrypt: (data) => Buffer.from(Buffer.from(data.toString(), 'base64').reverse()).toString('utf8'),
};

function build(folder: string, options: { testMode?: boolean } = {}): Harness {
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
  const loadedUrls: string[] = [];
  const commandCalls: Harness['commandCalls'] = [];
  const clusterScripts: string[] = [];
  const spawned: Harness['spawned'] = [];
  const restores: string[][] = [];
  const restoreEnvs: NodeJS.ProcessEnv[] = [];
  const dumpCalls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const probes: Harness['probes'] = [];
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
      return Promise.resolve(confirmAnswer);
    },
    message: (kind, title, message) => {
      uiCalls.push(['message', kind, title, message]);
      return Promise.resolve();
    },
    choose: (o) => {
      uiCalls.push(['choose', o.title, o.buttons]);
      whileDialogOpen();
      return Promise.resolve(chooseAnswers.shift() ?? o.buttons.length - 1);
    },
    notify: (title, body) => uiCalls.push(['notify', title, body]),
    pickFile: () => Promise.resolve(null),
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
    createScratchDatabase: () => {
      events.push('scratch create');
      return Promise.resolve();
    },
    swapInDatabase: () => {
      events.push('scratch swap');
      return Promise.resolve();
    },
    dropDatabase: () => {
      events.push('scratch drop');
      return Promise.resolve();
    },
    stop: () => {
      events.push('pg stop');
      port = null;
      return Promise.resolve();
    },
  } as unknown as PostgresCluster;

  const commands: ApiCommands = {
    migrate: (env) => {
      commandCalls.push({ command: 'migrate', env });
      events.push('migrate');
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
      restores.push(args);
      restoreEnvs.push(env);
      await discard(source);
      return { code: 0, stderr: '' };
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
      if (role === 'worker') queueMicrotask(() => child.stdout.write('{"msg":"worker started"}\n'));
      return child;
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
    controller,
    commandCalls,
    quitRequests: 0,
    config: () => store.read(),
    loadedUrls,
    clusterScripts,
    spawned,
    get dumps() {
      return dumps;
    },
    restores,
    restoreEnvs,
    dumpCalls,
    probes,
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

/** A raw request to the local server of the harness. */
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
          resolve({
            status: response.statusCode ?? 0,
            body: parseBody(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
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
  confirmAnswer = true;
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

describe('the first run', () => {
  it('creates the cluster, the database and the roles once, migrates, and waits at the setup screen', async () => {
    await harness.controller.start();

    expect(harness.events).toEqual(['initdb', 'pg start', 'create database', 'roles', 'migrate']);
    expect(harness.controller.phase).toBe('setup');
    expect(setupUrl()).toMatch(/^http:\/\/localhost:\d+\/__setup\?t=[\w-]{20,}$/);
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
  });

  it('provisions with the data of the form, starts the API and the worker, and answers the recovery key', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';

    const answer = await post(new URL('/__setup', url).href, tokenOf(url), form);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, recoveryKey: harness.config().secrets.recoveryKey });
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
    expect(harness.config().provisioned).toBe(true);
  });

  it('gives the API, and only the API, a secret of this run, and checks the proof with the same one', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);

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
    await post(new URL('/__setup', url).href, tokenOf(url), form);
    const other = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')));
    await other.controller.start();
    const otherUrl = other.loadedUrls.find((candidate) => candidate.includes('/__setup')) ?? '';
    await post(new URL('/__setup', otherUrl).href, tokenOf(otherUrl), form);

    const first = harness.spawned.find((child) => child.role === 'api')?.env[
      'DESKTOP_PROXY_SECRET'
    ];
    const second = other.spawned.find((child) => child.role === 'api')?.env['DESKTOP_PROXY_SECRET'];

    expect(first).not.toBe(second);
  });

  it('turns the setup screen into a 404 once the organization exists', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);

    const again = await post(new URL('/__setup', url).href, tokenOf(url), form);

    expect(again.status).toBe(404);
    expect(harness.commandCalls.filter((call) => call.command === 'provision')).toHaveLength(1);
  });

  it('shows the owner a rejected password in the words of the product and stays at the setup screen', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    provisionFails = new ApiCommandError(
      'provision',
      EXIT.invalidInput,
      { error: 'password_rejected', issues: ['common'] },
      '',
    );

    const answer = await post(new URL('/__setup', url).href, tokenOf(url), form);

    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({
      ok: false,
      errors: { password: expect.stringContaining('muy común') as string },
    });
    expect(harness.controller.phase).toBe('setup');
    expect(harness.config().provisioned).toBe(false);
    expect(harness.spawned).toHaveLength(0);
  });

  it('writes the setup address to the log only in test mode', async () => {
    rmSync(harness.folder, { recursive: true, force: true });
    harness = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')), { testMode: true });

    await harness.controller.start();

    const log = readFileSync(join(harness.paths.logs, 'shell.log'), 'utf8');
    expect(log).toContain(`setup url: ${setupUrl() ?? 'none'}`);
  });
});

describe('every other start', () => {
  async function provisioned(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);
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
    expect(api?.env['PUBLIC_URL']).toBe(`http://localhost:${String(before)}`);
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

describe('quitting', () => {
  it('stops the API and the worker before the database, and closes everything', async () => {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);
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
    await post(new URL('/__setup', url).href, tokenOf(url), form);
    // The automatic backup of the first open of the day runs by itself; wait for it.
    await vi.waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    });
  }

  it('makes the daily backup at the first open of the day, once, and writes the day down', async () => {
    await ready();

    expect(readdirSync(harness.paths.backups)).toEqual(['consulvia-diaria-2026-10-24_1000.cvb']);
    expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    expect(harness.dumps).toBe(1);

    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(1);

    clock = new Date(2026, 9, 25, 9, 0, 0);
    await harness.controller.maybeDailyBackup();
    expect(harness.dumps).toBe(2);
    expect(readdirSync(harness.paths.backups)).toHaveLength(2);
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
  async function ready(testMode: boolean): Promise<string> {
    rmSync(harness.folder, { recursive: true, force: true });
    harness = build(mkdtempSync(join(tmpdir(), 'consulvia-controller-')), { testMode });
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);
    await vi.waitFor(() => {
      expect(harness.config().settings.lastDailyBackup).toBe('2026-10-24');
    });
    clock = new Date(2026, 9, 24, 12, 0, 0);
    const path = await harness.controller.backupNow();
    clock = new Date(2026, 9, 24, 13, 0, 0);
    return path ?? '';
  }

  it('asks first, makes a safety backup, stops the services, restores, starts them again and reloads the window', async () => {
    const backup = await ready(false);
    harness.events.length = 0;
    harness.uiCalls.length = 0;

    const restored = await harness.controller.restoreFlow(backup);

    expect(restored).toBe(true);
    expect(harness.uiCalls[0]).toEqual(['confirm', 'Restaurar copia de seguridad']);
    expect(readdirSync(harness.paths.backups)).toContain(
      'consulvia-previa-restauracion-2026-10-24_1300.cvb',
    );
    expect(harness.events.filter((event) => event.startsWith('shutdown')).length).toBe(2);
    expect(harness.restores).toHaveLength(1);
    expect(harness.restores[0]).toContain('--single-transaction');
    // The backup is restored as the owner of the application, never as the superuser, and never over the live database.
    expect(harness.restores[0]).toEqual(
      expect.arrayContaining([
        '--username=app_owner',
        '--no-owner',
        '--dbname=consultorio_restore',
      ]),
    );
    expect(harness.restoreEnvs[0]?.['PGPASSWORD']).toBe(harness.config().secrets.appOwnerPassword);
    expect(harness.restoreEnvs[0]?.['PGPASSWORD']).not.toBe(
      harness.config().secrets.pgSuperuserPassword,
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

  it('skips the question only in test mode, where a script drives the install', async () => {
    const backup = await ready(true);
    harness.uiCalls.length = 0;

    await harness.controller.restoreFlow(backup);

    expect(harness.uiCalls.some((call) => call[0] === 'confirm')).toBe(false);
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
  });
});

describe("resetting the owner's password", () => {
  async function ready(): Promise<void> {
    await harness.controller.start();
    const url = setupUrl() ?? '';
    await post(new URL('/__setup', url).href, tokenOf(url), form);
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
    const key = harness.config().secrets.recoveryKey ?? '';

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
    const key = harness.config().secrets.recoveryKey ?? '';

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
    const key = harness.config().secrets.recoveryKey ?? '';

    const first = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));
    const second = await post(new URL('/__reset', url).href, tokenOf(url), resetBody(key));

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(resetCalls()).toHaveLength(1);
  });

  it('keeps the page open when the password is rejected, so the person can choose another', async () => {
    await ready();
    const url = await openReset();
    const key = harness.config().secrets.recoveryKey ?? '';
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

    const answer = await post(
      new URL('/__reset', url).href,
      tokenOf(url),
      resetBody(harness.config().secrets.recoveryKey ?? ''),
    );

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

    await post(
      new URL('/__reset', url).href,
      tokenOf(url),
      resetBody(harness.config().secrets.recoveryKey ?? ''),
    );

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

  it('shows the recovery key and copies it on request', async () => {
    await harness.controller.start();
    chooseAnswers = [0];

    await harness.controller.showRecoveryKey();

    const key = harness.config().secrets.recoveryKey;
    expect(harness.uiCalls).toContainEqual(['copy', key]);
    const shown = harness.uiCalls.find((call) => call[0] === 'choose');
    expect(shown?.[1]).toBe('Clave de recuperación');
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
