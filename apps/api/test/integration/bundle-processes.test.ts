import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildBundle } from '../../scripts/build-bundle.js';

/**
 * The processes of a desktop install as the shell starts them: the BUILT bundle, one child process each,
 * the environment of the desktop profile, a pipe for the standard input and an IPC channel. Nothing of
 * the repository is used except the `node_modules` the bundle's dependencies come from and the folder
 * of assets, found from the working directory.
 */
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRATCH = join(API_ROOT, 'node_modules', '.cache', 'bundle-test');
const SLUG = 'bundle-clinic';
const OWNER_EMAIL = 'ana@bundle-clinic.example';
const OWNER_PASSWORD = 'una frase larga y privada del consultorio';
/** The secret of the run that the local server of the shell shares with the API. */
const PROXY_SECRET = randomBytes(32).toString('hex');

let bundle: string;
let dataDir: string;
let port: number;
let env: Record<string, string>;
const running: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const chosen = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(chosen);
      });
    });
  });
}

beforeAll(async () => {
  bundle = join(SCRATCH, randomUUID());
  dataDir = await mkdtemp(join(tmpdir(), 'consulvia-bundle-data-'));
  port = await freePort();
  await buildBundle({ outdir: bundle });
  // What the shell gives every process of the install; the worker also gets the sealer login.
  env = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'desktop',
    DEPLOYMENT_MODE: 'single',
    SINGLE_TENANT_SLUG: SLUG,
    PUBLIC_URL: `http://127.0.0.1:${String(port)}`,
    PORT: String(port),
    LOG_LEVEL: 'warn',
    DATABASE_URL: inject('runtimeUrl'),
    KMS_PROVIDER: 'local',
    KMS_LOCAL_KEK_BASE64: randomBytes(32).toString('base64'),
    ADDRESS_HASH_PEPPER: randomBytes(32).toString('hex'),
    STORAGE_DIR: join(dataDir, 'files'),
    STORAGE_UPLOAD_SECRET: randomBytes(32).toString('hex'),
    OUTBOX_DIR: join(dataDir, 'outbox'),
  };
}, 120_000);

afterAll(async () => {
  for (const child of running) if (child.exitCode === null) child.kill();
  await rm(bundle, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

interface Started {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

/** Starts `main.js <args>` the way the shell does: working directory of the API, pipe, IPC. */
function start(args: string[], extra: Record<string, string> = {}, input?: string): Started {
  const child = spawn(process.execPath, [join(bundle, 'main.js'), ...args], {
    cwd: API_ROOT,
    env: { ...env, ...extra },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  running.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  if (input !== undefined) child.stdin?.end(input);
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const origin = () => `http://127.0.0.1:${String(port)}`;

/** The API of a desktop install, with the secret the shell gives it. */
function startApi(extra: Record<string, string> = {}): Started {
  return start(['api'], { DESKTOP_PROXY_SECRET: PROXY_SECRET, ...extra });
}

/** What the local server of the shell adds to every request it forwards. */
const viaShell = { 'x-consulvia-proxy': PROXY_SECRET };

/** The status of `GET /health` through the shell with the `Host` the request names. */
function statusWithHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/health', headers: { ...viaShell, host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** The health probe of the shell: no secret, a nonce, and the proof is checked. */
async function probe(): Promise<Response> {
  return fetch(`${origin()}/health`, {
    headers: { 'x-consulvia-nonce': 'probenonceprobenonce' },
  });
}

describe('the built bundle with the desktop profile', () => {
  it('provisions the organization, serves it on the loopback, and stops on the shutdown message', async () => {
    const provision = start(
      ['provision', '--stdin'],
      {},
      JSON.stringify({
        organizationName: 'Clínica del Bundle',
        ownerName: 'Dra. Ana Gómez',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
      }),
    );
    expect(await provision.exited).toBe(0);
    expect(JSON.parse(provision.stdout().trim())).toMatchObject({ result: 'created', slug: SLUG });
    expect(provision.stdout() + provision.stderr()).not.toContain(OWNER_PASSWORD);

    const api = startApi();
    try {
      await until(async () => {
        if (api.child.exitCode !== null) throw new Error(`the api exited: ${api.stderr()}`);
        try {
          return (await probe()).status === 200;
        } catch {
          return false;
        }
      }, '/health');

      // Anything that does not come through the local server of the shell is refused, and the probe gets a proof.
      const direct = await fetch(`${origin()}/auth/me`);
      expect(direct.status).toBe(403);
      const wrong = await fetch(`${origin()}/auth/me`, {
        headers: { 'x-consulvia-proxy': `${PROXY_SECRET.slice(1)}x` },
      });
      expect(wrong.status).toBe(403);
      const proof = (await probe()).headers.get('x-consulvia-proof');
      expect(proof).toBe(
        createHmac('sha256', PROXY_SECRET)
          .update('consulvia-health:probenonceprobenonce')
          .digest('hex'),
      );
      // fetch cannot choose its Host; a page that rebinds its own name to 127.0.0.1 can.
      expect(await statusWithHost('evil.example')).toBe(403);
      expect(await statusWithHost(`127.0.0.1:${String(port)}`)).toBe(200);

      // Only the loopback: the process listens on 127.0.0.1 and nowhere else.
      const login = await fetch(`${origin()}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: origin(), ...viaShell },
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toMatch(/^sid=/);
      const me = await fetch(`${origin()}/auth/me`, { headers: { cookie, ...viaShell } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { roles: string[] }).roles).toEqual(['owner']);

      // The route that takes the browser's uploads exists, because the files are on the disk.
      const upload = await fetch(`${origin()}/files/uploads/not-a-token`, {
        method: 'POST',
        headers: {
          origin: origin(),
          'content-type': 'multipart/form-data; boundary=x',
          ...viaShell,
        },
        body: '--x--\r\n',
      });
      expect(upload.status).toBe(403);

      api.child.send({ type: 'shutdown' });
      expect(await api.exited).toBe(0);
      expect(api.stderr()).toBe('');
    } finally {
      if (api.child.exitCode === null) api.child.kill();
    }
  }, 180_000);

  it('runs the worker, and stops it on the shutdown message', async () => {
    // The worker says it started at the info level.
    const worker = start(['worker'], {
      AUDIT_SEALER_DATABASE_URL: inject('sealerUrl'),
      LOG_LEVEL: 'info',
    });
    try {
      await until(() => {
        if (worker.child.exitCode !== null)
          throw new Error(`the worker exited: ${worker.stderr()}`);
        return worker.stdout().includes('worker started');
      }, 'the worker to start');

      worker.child.send({ type: 'shutdown' });

      expect(await worker.exited).toBe(0);
      expect(worker.stdout()).toContain('worker stopped');
    } finally {
      if (worker.child.exitCode === null) worker.child.kill();
    }
  }, 180_000);

  it('stops when the shell goes away and closes the channel', async () => {
    const api = startApi();
    try {
      await until(async () => {
        if (api.child.exitCode !== null) throw new Error(`the api exited: ${api.stderr()}`);
        try {
          return (await probe()).status === 200;
        } catch {
          return false;
        }
      }, '/health');

      api.child.disconnect();

      expect(await api.exited).toBe(0);
    } finally {
      if (api.child.exitCode === null) api.child.kill();
    }
  }, 180_000);

  it('refuses to start the API without the secret of the run, naming the variable', async () => {
    const api = start(['api']);

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('DESKTOP_PROXY_SECRET');
  }, 60_000);

  it('refuses to start with a configuration the profile does not allow, naming the variable', async () => {
    const api = start(['api'], { HOST: '0.0.0.0' });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('HOST');
    expect(api.stderr()).not.toContain('0.0.0.0');
  }, 60_000);
});
