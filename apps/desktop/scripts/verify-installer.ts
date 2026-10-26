import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArchiveWriter, readArchiveHeader } from '../src/backup-archive.js';
import { keyIdOf, newBackupKey, wrapBackupKey } from '../src/backup-crypto.js';

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `json<T>()` is a typed view of a JSON answer, checked by the assertions that follow. */

/**
 * Checks a built installer the way a clinic would use it, from outside the program:
 *
 *   pnpm --filter @consultorio/desktop verify:installer [path\to\Consulvia-Setup-x.y.z.exe]
 *
 * It installs the program silently into a temporary folder, drives the first-run screen and the API over
 * HTTP through the local server, makes and restores a backup, quits and starts again, resets the owner's
 * password and uninstalls. The data goes to a temporary folder (`CONSULVIA_DATA_DIR`), so a real install
 * on the same PC is not touched. The installer adds and removes a desktop shortcut and a Start-menu entry
 * of the current Windows user, like any install does.
 *
 * `--upgrade-to=<path\to\Consulvia-Setup-x.y.z.exe>` adds the upgrade scenario: that (newer) installer is run
 * over the program while it is running, and the data must survive. `--keep` leaves the temporary folder.
 */
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));

interface Result {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];

async function check(
  step: string,
  work: () => Promise<string | undefined> | string | undefined,
): Promise<void> {
  const started = Date.now();
  try {
    const detail = (await work()) ?? '';
    results.push({ step, ok: true, detail, ms: Date.now() - started });
    console.log(`PASS  ${step}${detail === '' ? '' : `  (${detail})`}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ step, ok: false, detail, ms: Date.now() - started });
    console.log(`FAIL  ${step}\n      ${detail}`);
    throw error;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  describe: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`);
    await sleep(everyMs);
  }
}

// ---- HTTP ---------------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text(): string;
  json<T = Record<string, unknown>>(): T;
}

class Client {
  private readonly cookies = new Map<string, string>();
  /**
   * `proof` gives the proof of the window that the program wrote in its log (it changes at every start): the
   * local server serves `/api` to nothing that does not carry it, and this client plays the window.
   */
  constructor(
    readonly base: URL,
    private readonly proof: () => string | undefined = () => undefined,
  ) {}

  call(
    method: string,
    path: string,
    options: {
      json?: unknown;
      body?: Buffer;
      headers?: Record<string, string>;
      token?: string;
      /** Leaves out the proof, like a program of the PC that is not the window. */
      withoutProof?: boolean;
    } = {},
  ): Promise<Reply> {
    const proof = options.withoutProof === true ? undefined : this.proof();
    const payload =
      options.body ??
      (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)));
    const headers: Record<string, string> = {
      host: this.base.host,
      origin: this.base.origin,
      ...(payload && options.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(payload ? { 'content-length': String(payload.length) } : {}),
      ...(options.token ? { 'x-consulvia-token': options.token } : {}),
      ...(proof ? { 'x-consulvia-window': proof } : {}),
      ...options.headers,
    };
    if (this.cookies.size > 0) {
      headers['cookie'] = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: Number(this.base.port), path, method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            for (const cookie of response.headers['set-cookie'] ?? []) {
              const [pair] = cookie.split(';');
              const [name, ...rest] = (pair ?? '').split('=');
              if (name) this.cookies.set(name, rest.join('='));
            }
            const body = Buffer.concat(chunks);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
              text: () => body.toString('utf8'),
              json: <T>() => JSON.parse(body.toString('utf8') || '{}') as T,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }

  forgetCookies(): void {
    this.cookies.clear();
  }
}

// ---- the program under test -------------------------------------------------------------------

interface Session {
  root: string;
  installDir: string;
  dataDir: string;
  backupDir: string;
  exe: string;
  env: NodeJS.ProcessEnv;
  shellLog: string;
}

function logText(session: Session): string {
  return existsSync(session.shellLog) ? readFileSync(session.shellLog, 'utf8') : '';
}

function lastMatch(text: string, pattern: RegExp): string | undefined {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].at(-1)?.[1];
}

function launch(session: Session, args: string[] = []): ChildProcess {
  return spawn(session.exe, args, { env: session.env, stdio: 'ignore', windowsHide: false });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else
      child.once('exit', (code) => {
        resolve(code);
      });
  });
}

/** The processes (ours, from the temporary folder) that are still alive. */
function leftovers(session: Session): { pid: number; name: string }[] {
  const script =
    // Every program of the install (Consulvia, PostgreSQL, the tools) runs from the install folder.
    `$root = '${session.installDir.replaceAll("'", "''")}'; ` +
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase') } | ` +
    "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.Name }";
  const output = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
    },
  ).stdout;
  return (
    output
      .split(/\r?\n/)
      .filter((line) => line.includes('|'))
      .map((line) => {
        const [pid, name] = line.split('|');
        return { pid: Number(pid), name: name ?? '' };
      })
      // The PowerShell that asks is not part of the program.
      .filter((entry) => entry.name.toLowerCase() !== 'powershell.exe')
  );
}

/** The files under `folder` (not the database, which is large and holds no such thing) that contain any of `needles`. */
function filesMentioning(folder: string, needles: string[]): string[] {
  const found: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'pgdata') visit(path);
      } else if (entry.isFile()) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(path);
        } catch {
          continue;
        }
        if (needles.some((needle) => bytes.includes(Buffer.from(needle)))) found.push(path);
      }
    }
  };
  visit(folder);
  return found;
}

// ---- TOTP, to enroll a second factor like a phone would ---------------------------------------

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of text.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// ---- a real window, driven over the DevTools protocol ----------------------------------------

async function screenshot(
  port: number,
  base: URL,
  client: Client,
  email: string,
  password: string,
  target: string,
) {
  const targets = await until(
    'the window in the DevTools list',
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
        const list = (await response.json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = list.find(
          (entry) => entry.type === 'page' && entry.url.startsWith(base.origin),
        );
        return page ? page.webSocketDebuggerUrl : undefined;
      } catch {
        return undefined;
      }
    },
    60_000,
  );
  const socket = new WebSocket(targets);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('DevTools connection failed'));
    });
  });
  let nextId = 0;
  const pending = new Map<
    number,
    (value: { result?: Record<string, unknown>; error?: { message: string } }) => void
  >();
  // What the page complains about while it loads: a blocked request, a policy violation, a script error.
  const problems: string[] = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'Network.loadingFailed' && params['canceled'] !== true) {
      problems.push(
        `request failed: ${String(params['errorText'])} ${JSON.stringify(params['blockedReason'] ?? '')}`,
      );
    } else if (message.method === 'Log.entryAdded') {
      const entry = params['entry'] as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level === 'error') problems.push(`log: ${entry.text ?? ''} ${entry.url ?? ''}`);
    } else if (message.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${JSON.stringify(params['exceptionDetails']).slice(0, 200)}`);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  try {
    // Sign in from inside the window, like the sign-in form does, so the cookie is the window's own.
    const evaluated = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    });
    const value = (evaluated['result'] as { value?: { status?: number } }).value;
    assert(value?.status === 200, `sign-in from the window answered ${String(value?.status)}`);
    await send('Page.enable');
    await send('Network.enable');
    await send('Log.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `${base.origin}/` });
    // Let the app load its screens, fonts and data.
    await sleep(6_000);
    const title = await send('Runtime.evaluate', {
      expression: 'document.title + " | " + location.pathname',
      returnByValue: true,
    });
    const csp = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => { const errors = []; resolve(JSON.stringify({ secure: window.isSecureContext, origin: location.origin, sw: 'serviceWorker' in navigator })); })`,
      awaitPromise: true,
      returnByValue: true,
    });
    const violations = problems.filter((problem) =>
      /Content Security Policy|Refused to|CSP|upgrade|mixed/i.test(problem),
    );
    assert(
      violations.length === 0,
      `the window reports policy problems: ${violations.join(' | ')}`,
    );
    const image = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, Buffer.from(String(image['data']), 'base64'));
    return `${String((title['result'] as { value?: string }).value)}; ${String((csp['result'] as { value?: string }).value)}; ${String(problems.length)} console/network problems${problems.length > 0 ? `: ${problems.slice(0, 3).join(' | ')}` : ''}`;
  } finally {
    socket.close();
  }
}

// ---- the script -------------------------------------------------------------------------------

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

const OWNER = {
  organizationName: 'Clínica Prueba',
  ownerName: 'Dra. Ana Gómez',
  ownerEmail: 'ana.gomez@clinica-prueba.example',
  password: 'una frase larga y privada del consultorio',
};

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  // `--program=<folder>` runs an unpacked program (release/win-unpacked) instead of the installer: the same
  // checks, minus the install and the uninstall, for the minutes it takes to repeat them.
  const unpacked = process.argv
    .find((argument) => argument.startsWith('--program='))
    ?.slice('--program='.length);
  const installer =
    process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
    join(desktopRoot, 'release', `Consulvia-Setup-${manifest.version}.exe`);
  assert(unpacked !== undefined || existsSync(installer), `no installer at ${installer}`);

  const root = await mkdtemp(join(tmpdir(), 'consulvia-verify-'));
  const session: Session = {
    root,
    installDir: unpacked ?? join(root, 'programa'),
    dataDir: join(root, 'datos'),
    backupDir: join(root, 'copias'),
    exe: join(unpacked ?? join(root, 'programa'), 'Consulvia.exe'),
    shellLog: join(root, 'datos', 'logs', 'shell.log'),
    env: {
      ...process.env,
      CONSULVIA_DATA_DIR: join(root, 'datos'),
      CONSULVIA_BACKUP_DIR: join(root, 'copias'),
      CONSULVIA_TEST_MODE: '1',
    },
  };
  console.log(
    `${unpacked === undefined ? `installer: ${installer}` : `program:   ${unpacked}`}\nfolder:    ${root}\n`,
  );

  let app: ChildProcess | undefined;
  let base!: URL;
  let web!: Client;
  let patientId = '';
  let documentId = '';
  let backupPath = '';
  let recoveryKey = '';
  let ackToken = '';
  /** The password of the owner now: the reset changes it. */
  let currentPassword = OWNER.password;
  /** The proof of the window that the running program wrote in its log: new at every start. */
  const proofOf = () => lastMatch(logText(session), /window proof: (\S+)/);
  /** How many times the program has written the address of the page that asks for the keys of a restore. */
  const keyPages = () => logText(session).split('restore keys url:').length - 1;
  /**
   * Asks the running program to restore `file`, like the tray does, and returns the one-time token of the page that
   * asks for the recovery key(s). Nothing is restored until the keys are sent.
   */
  const startRestore = async (file: string): Promise<string> => {
    const before = keyPages();
    await exited(launch(session, [`--restore=${file}`]));
    const url = await until(
      'the address of the page that asks for the keys',
      () =>
        keyPages() > before ? lastMatch(logText(session), /restore keys url: (\S+)/) : undefined,
      180_000,
    );
    return new URL(url).searchParams.get('t') ?? '';
  };
  const sendKeys = (token: string, keys: Record<string, string>) =>
    new Client(base, proofOf).call('POST', '/__key', { token, json: keys });
  const patientCount = async (): Promise<number> => {
    const client = new Client(base, proofOf);
    const login = await client.call('POST', '/api/auth/login', {
      json: { email: OWNER.ownerEmail, password: currentPassword },
    });
    assert(login.status === 200, `login answered ${String(login.status)}`);
    return (await client.call('GET', '/api/patients')).json<{ patients: unknown[] }>().patients
      .length;
  };
  const upgradeTo = process.argv
    .find((argument) => argument.startsWith('--upgrade-to='))
    ?.slice('--upgrade-to='.length);

  try {
    await check('install silently into a temporary folder (/S)', async () => {
      if (unpacked === undefined) {
        const setup = spawn(installer, ['/S', `/D=${session.installDir}`], {
          env: session.env,
          stdio: 'ignore',
        });
        const code = await exited(setup);
        assert(code === 0, `the installer exited with ${String(code)}`);
      }
      await until(
        'Consulvia.exe in the install folder',
        () => (existsSync(session.exe) ? true : undefined),
        60_000,
      );
      for (const file of [
        'resources/api/dist/main.js',
        'resources/api/dist/migrations/meta/_journal.json',
        'resources/api/assets/common-passwords-100k.txt',
        'resources/web/index.html',
        'resources/postgres/bin/postgres.exe',
        'resources/tools/pg_dump.exe',
        'resources/tools/pg_restore.exe',
        'resources/sql/01-roles.sql',
        'resources/app.asar',
      ]) {
        assert(existsSync(join(session.installDir, file)), `missing in the install: ${file}`);
      }
      return 'files in place';
    });

    await check(
      'first run: the program starts by itself or when launched, and offers the setup screen',
      async () => {
        // The one-click installer starts the program when it finishes; if it did not, start it.
        await sleep(4_000);
        if (!existsSync(session.shellLog)) app = launch(session);
        const url = await until(
          'the setup address in the log',
          () => lastMatch(logText(session), /setup url: (\S+)/),
          600_000,
        );
        const parsed = new URL(url);
        base = new URL(parsed.origin);
        web = new Client(base, proofOf);
        return `bootstrap done; ${base.origin}`;
      },
    );

    await check('the setup screen needs its token and refuses strangers', async () => {
      const url = lastMatch(logText(session), /setup url: (\S+)/) ?? '';
      const token = new URL(url).searchParams.get('t') ?? '';
      assert(
        (await web.call('GET', '/__setup')).status === 404,
        'setup page without a token should be 404',
      );
      assert(
        (await web.call('GET', '/__setup?t=wrong')).status === 404,
        'setup page with a wrong token should be 404',
      );
      const page = await web.call('GET', `/__setup?t=${token}`);
      assert(page.status === 200, `setup page answered ${String(page.status)}`);
      assert(page.text().includes('Bienvenido a Consulvia'), 'the setup page is not in Spanish');
      const forged = await web.call('POST', '/__setup', { json: {}, token: 'wrong' });
      assert(forged.status === 404, 'a POST with a wrong token should be 404');
      const rebinding = await web.call('GET', '/', { headers: { host: 'evil.example' } });
      assert(
        rebinding.status === 421,
        `a foreign Host should be 421, got ${String(rebinding.status)}`,
      );
      const bad = await web.call('POST', '/__setup', {
        token,
        json: {
          ...OWNER,
          passwordConfirmation: 'otra',
          timeZone: 'America/Argentina/Buenos_Aires',
        },
      });
      assert(bad.status === 422, `an invalid form should be 422, got ${String(bad.status)}`);
      return `form errors in Spanish: ${bad.text().slice(0, 90)}`;
    });

    await check(
      'a setup that is interrupted after the key is shown and before it is confirmed creates nothing, and asks again with a new key',
      async () => {
        const url = lastMatch(logText(session), /setup url: (\S+)/) ?? '';
        const token = new URL(url).searchParams.get('t') ?? '';
        const form = {
          organizationName: OWNER.organizationName,
          ownerName: OWNER.ownerName,
          ownerEmail: OWNER.ownerEmail,
          password: OWNER.password,
          passwordConfirmation: OWNER.password,
          timeZone: 'America/Argentina/Buenos_Aires',
        };
        const shown = await web.call('POST', '/__setup', { token, json: form });
        assert(shown.status === 200, `setup answered ${String(shown.status)}`);
        const first = shown.json<{ recoveryKey: string; ackToken: string }>();
        // The key is on the screen and NOTHING exists: the API is not running, the form is still there.
        assert(
          (await web.call('GET', '/api/health')).status === 503,
          'the services started before the key was confirmed',
        );
        assert(
          (await web.call('GET', `/__setup?t=${token}`)).status === 200,
          'the form is gone before the key was confirmed',
        );
        // The program closes (the window, a power cut) before the owner confirms.
        const addresses = logText(session).split('setup url:').length - 1;
        await exited(launch(session, ['--quit']));
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process of the install to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          240_000,
          1_000,
        );
        app = launch(session);
        const next = await until(
          'the setup address after the restart',
          () =>
            logText(session).split('setup url:').length - 1 > addresses
              ? lastMatch(logText(session), /setup url: (\S+)/)
              : undefined,
          600_000,
        );
        web = new Client(new URL(new URL(next).origin), proofOf);
        const nextToken = new URL(next).searchParams.get('t') ?? '';
        // The old confirmation does not exist any more, and nothing was created in between.
        const stale = await web.call('POST', '/__ack', {
          token: first.ackToken,
          json: { recoveryKeyLast4: first.recoveryKey.slice(-4) },
        });
        assert(stale.status === 404, `the old confirmation answered ${String(stale.status)}`);
        assert(
          (await web.call('GET', '/api/health')).status === 503,
          'the services are running after an interrupted setup',
        );
        const found = filesMentioning(session.dataDir, [first.recoveryKey]);
        assert(
          found.length === 0,
          `the key of the interrupted setup is written in ${found.join(', ')}`,
        );
        const second = await web.call('POST', '/__setup', { token: nextToken, json: form });
        assert(second.status === 200, `the second setup answered ${String(second.status)}`);
        assert(
          second.json<{ recoveryKey: string }>().recoveryKey !== first.recoveryKey,
          'the same key was shown again',
        );
        return 'nothing created; the form came back and made a new key';
      },
    );

    await check(
      'set up "Clínica Prueba" with an owner (the key is shown first; POST /__setup creates nothing yet)',
      async () => {
        const url = lastMatch(logText(session), /setup url: (\S+)/) ?? '';
        const token = new URL(url).searchParams.get('t') ?? '';
        const answer = await web.call('POST', '/__setup', {
          token,
          json: {
            organizationName: OWNER.organizationName,
            ownerName: OWNER.ownerName,
            ownerEmail: OWNER.ownerEmail,
            password: OWNER.password,
            passwordConfirmation: OWNER.password,
            timeZone: 'America/Argentina/Buenos_Aires',
          },
        });
        assert(
          answer.status === 200,
          `setup answered ${String(answer.status)}: ${answer.text().slice(0, 200)}`,
        );
        const body = answer.json<{ ok: boolean; recoveryKey: string; ackToken: string }>();
        assert(
          body.ok && /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/.test(body.recoveryKey),
          'no recovery key in the answer',
        );
        assert(body.ackToken.length >= 20, 'no token to confirm the key');
        recoveryKey = body.recoveryKey;
        ackToken = body.ackToken;
        // Nothing is created until the key is confirmed: the API is not running yet, and the form still works.
        assert(
          (await web.call('GET', '/api/health')).status === 503,
          'the services started before the key was confirmed',
        );
        assert(
          (await web.call('GET', `/__setup?t=${token}`)).status === 200,
          'the setup page is gone before the key was confirmed',
        );
        return 'recovery key shown; nothing created yet';
      },
    );

    await check(
      'the recovery key is confirmed with its last four characters (and the token works once)',
      async () => {
        // The key was shown once, in the answer to the setup. No page shows it again, with any token.
        const page = await web.call('GET', `/__ack?t=${ackToken}`);
        assert(page.status === 404, `a page for the recovery key answered ${String(page.status)}`);
        const wrong = await web.call('POST', '/__ack', {
          token: ackToken,
          json: { recoveryKeyLast4: 'ZZZZ' },
        });
        assert(wrong.status === 422, `a wrong tail answered ${String(wrong.status)}`);
        const short = await web.call('POST', '/__ack', {
          token: ackToken,
          json: { recoveryKeyLast4: 'AB' },
        });
        assert(short.status === 422, `a short tail answered ${String(short.status)}`);
        const right = await web.call('POST', '/__ack', {
          token: ackToken,
          json: { recoveryKeyLast4: recoveryKey.slice(-4).toLowerCase() },
        });
        assert(
          right.status === 200,
          `the right tail answered ${String(right.status)}: ${right.text()}`,
        );
        // Confirming the key is what creates the organization, and the setup page is gone for good.
        const setupToken =
          new URL(lastMatch(logText(session), /setup url: (\S+)/) ?? '').searchParams.get('t') ??
          '';
        assert(
          (await web.call('GET', `/__setup?t=${setupToken}`)).status === 404,
          'the setup page must be 404 once the organization exists',
        );
        const again = await web.call('POST', '/__ack', {
          token: ackToken,
          json: { recoveryKeyLast4: recoveryKey.slice(-4) },
        });
        assert(again.status === 404, 'the confirmation token must work once');
        assert(
          !logText(session).includes(recoveryKey),
          'the recovery key is in the log of the program',
        );
        return 'confirmed; the key is not kept on this PC any more';
      },
    );

    await check(
      'the recovery key is never shown again and is written nowhere on this PC (no log, no file, no page)',
      () => {
        const found = filesMentioning(session.dataDir, [
          recoveryKey,
          recoveryKey.replaceAll('-', ''),
        ]);
        assert(found.length === 0, `the recovery key is written in: ${found.join(', ')}`);
        const config = JSON.parse(readFileSync(join(session.dataDir, 'config.json'), 'utf8')) as {
          public: { recoveryAcknowledged: boolean };
        };
        assert(config.public.recoveryAcknowledged, 'the key is not marked as confirmed');
        return 'no file under the data folder holds the key; it was in the answer to the setup only';
      },
    );

    await check('GET /api/health through the local server answers 200', async () => {
      const reply = await web.call('GET', '/api/health');
      assert(reply.status === 200, `health answered ${String(reply.status)}`);
      const ready = await web.call('GET', '/api/ready');
      assert(ready.status === 200, `ready answered ${String(ready.status)}`);
      return reply.text();
    });

    await check(
      'a request to 127.0.0.1:<port>/api/... without the proof of the window is refused (403) and never reaches the API',
      async () => {
        for (const [method, path] of [
          ['GET', '/api/health'],
          ['GET', '/api/patients'],
          ['POST', '/api/auth/login'],
        ] as const) {
          const reply = await web.call(method, path, {
            withoutProof: true,
            ...(method === 'POST' ? { json: {} } : {}),
          });
          assert(
            reply.status === 403,
            `${method} ${path} without the proof answered ${String(reply.status)}`,
          );
        }
        const forged = await web.call('GET', '/api/health', {
          withoutProof: true,
          headers: { 'x-consulvia-window': 'a-guess-at-the-proof' },
        });
        assert(forged.status === 403, `a wrong proof answered ${String(forged.status)}`);
        // A page of the shell that is not the API still needs its token, and the bundle is public.
        assert((await web.call('GET', '/', { withoutProof: true })).status === 200, 'bundle');
        assert(
          (await web.call('GET', '/manifest.webmanifest', { withoutProof: true })).status === 200,
          'the public manifest should not need the proof',
        );
        const log = logText(session);
        assert(
          log.includes('a request to the API without the proof of the window was refused'),
          'the refusal is not in the log',
        );
        return '403 for the API without the proof, with a wrong one; the bundle and the public routes stay open';
      },
    );

    await check(
      'the web app is served with its Content Security Policy and the service worker is not cached',
      async () => {
        const page = await web.call('GET', '/');
        assert(
          page.status === 200 && page.text().includes('<div id="root"'),
          'index.html was not served',
        );
        const csp = String(page.headers['content-security-policy'] ?? '');
        assert(csp.includes("default-src 'self'"), 'no Content Security Policy on the page');
        const worker = await web.call('GET', '/sw.js');
        assert(
          worker.status === 200 && worker.headers['cache-control'] === 'no-cache',
          'sw.js must be served with no-cache',
        );
        const manifestReply = await web.call('GET', '/manifest.webmanifest');
        assert(
          manifestReply.status === 200 && manifestReply.text().includes('Clínica Prueba'),
          'the manifest of the organization was not proxied',
        );
        const fallback = await web.call('GET', '/patients/does-not-exist-as-a-file');
        assert(
          fallback.status === 200 && fallback.text().includes('<div id="root"'),
          'the SPA fallback is missing',
        );
        return `CSP ${String(csp.length)} characters; upgrade-insecure-requests ${csp.includes('upgrade-insecure-requests') ? 'present' : 'absent'}`;
      },
    );

    await check('sign in as the owner through /api/auth/login', async () => {
      const wrong = await web.call('POST', '/api/auth/login', {
        json: { email: OWNER.ownerEmail, password: 'otra frase larga y equivocada' },
      });
      assert(wrong.status === 401, `a wrong password answered ${String(wrong.status)}`);
      const reply = await web.call('POST', '/api/auth/login', {
        json: { email: OWNER.ownerEmail, password: OWNER.password },
      });
      assert(reply.status === 200, `login answered ${String(reply.status)}: ${reply.text()}`);
      const me = await web.call('GET', '/api/auth/me');
      assert(me.status === 200, `/auth/me answered ${String(me.status)}`);
      return `next: ${reply.json<{ next: string }>().next}; session cookie is sid`;
    });

    await check('list patients (empty), create one, list again', async () => {
      const empty = await web.call('GET', '/api/patients');
      assert(
        empty.status === 200 && empty.json<{ patients: unknown[] }>().patients.length === 0,
        `expected no patients: ${empty.text()}`,
      );
      const created = await web.call('POST', '/api/patients', {
        json: {
          familyName: 'Pérez',
          givenNames: 'María Luisa',
          birthDate: '1985-03-14',
          document: { type: 'dni', number: '30111222' },
          dataProcessingConsent: true,
        },
      });
      assert(
        created.status === 201 || created.status === 200,
        `create answered ${String(created.status)}: ${created.text()}`,
      );
      patientId = created.json<{ patient: { id: string } }>().patient.id;
      assert(patientId !== '', 'no patient id');
      const list = await web.call('GET', '/api/patients');
      assert(
        list.json<{ patients: unknown[] }>().patients.length === 1,
        `expected one patient: ${list.text()}`,
      );
      return `patient ${patientId}`;
    });

    await check(
      'upload a PDF through the real presigned-upload flow; it is scanned and downloadable',
      async () => {
        const requested = await web.call('POST', '/api/documents/uploads', {
          json: {
            patientId,
            category: 'id_copy',
            files: [{ name: 'dni-frente.pdf', contentType: 'application/pdf', size: PDF.length }],
          },
        });
        assert(
          requested.status === 200,
          `upload request answered ${String(requested.status)}: ${requested.text()}`,
        );
        const first = requested.json<{
          uploads: { id: string; upload: { url: string; fields: Record<string, string> } }[];
        }>().uploads[0];
        assert(first, 'no upload was created');
        documentId = first.id;
        assert(
          first.upload.url.startsWith('/api/files/uploads/'),
          `unexpected upload address ${first.upload.url}`,
        );

        const form = new FormData();
        for (const [name, value] of Object.entries(first.upload.fields)) form.append(name, value);
        form.append(
          'file',
          new Blob([new Uint8Array(PDF)], { type: 'application/pdf' }),
          'dni-frente.pdf',
        );
        const multipart = new Response(form);
        const sent = await web.call('POST', first.upload.url, {
          body: Buffer.from(await multipart.arrayBuffer()),
          headers: { 'content-type': multipart.headers.get('content-type') ?? '' },
        });
        assert(
          sent.status === 204 || sent.status === 200 || sent.status === 201,
          `the upload to storage answered ${String(sent.status)}: ${sent.text()}`,
        );
        const confirmed = await web.call('POST', `/api/documents/${documentId}/uploaded`);
        assert(
          confirmed.status === 200,
          `confirmation answered ${String(confirmed.status)}: ${confirmed.text()}`,
        );

        const available = await until(
          'the document to be scanned',
          async () => {
            const list = await web.call('GET', `/api/patients/${patientId}/documents`);
            const documents = list.json<{
              documents: { id: string; status: string; rejectionReason: string | null }[];
            }>().documents;
            const found = documents.find((entry) => entry.id === documentId);
            if (found?.status === 'rejected')
              throw new Error(`the PDF was rejected: ${String(found.rejectionReason)}`);
            return found?.status === 'available' ? found : undefined;
          },
          240_000,
        );
        const link = await web.call('POST', `/api/documents/${documentId}/download-link`);
        assert(
          link.status === 200,
          `download link answered ${String(link.status)}: ${link.text()}`,
        );
        const download = await web.call('GET', `/api${link.json<{ url: string }>().url}`);
        assert(
          download.status === 200 && download.body.equals(PDF),
          'the downloaded bytes are not the uploaded PDF',
        );
        assert(
          String(download.headers['content-type']).startsWith('application/pdf'),
          `content type ${String(download.headers['content-type'])}`,
        );
        return `status ${available.status}; ${String(download.body.length)} identical bytes; content-type ${String(download.headers['content-type'])}`;
      },
    );

    await check('the scanner rejects the EICAR test file', async () => {
      const requested = await web.call('POST', '/api/documents/uploads', {
        json: {
          patientId,
          category: 'other_administrative',
          files: [{ name: 'prueba.txt', contentType: 'text/plain', size: EICAR.length }],
        },
      });
      const first = requested.json<{
        uploads: { id: string; upload: { url: string; fields: Record<string, string> } }[];
      }>().uploads[0];
      assert(first, 'no upload was created');
      const form = new FormData();
      for (const [name, value] of Object.entries(first.upload.fields)) form.append(name, value);
      form.append('file', new Blob([new Uint8Array(EICAR)], { type: 'text/plain' }), 'prueba.txt');
      const multipart = new Response(form);
      await web.call('POST', first.upload.url, {
        body: Buffer.from(await multipart.arrayBuffer()),
        headers: { 'content-type': multipart.headers.get('content-type') ?? '' },
      });
      await web.call('POST', `/api/documents/${first.id}/uploaded`);
      const rejected = await until(
        'the EICAR file to be rejected',
        async () => {
          const list = await web.call('GET', `/api/patients/${patientId}/documents`);
          const found = list
            .json<{ documents: { id: string; status: string; rejectionReason: string | null }[] }>()
            .documents.find((entry) => entry.id === first.id);
          return found?.status === 'rejected' ? found : undefined;
        },
        240_000,
      );
      return `rejected: ${String(rejected.rejectionReason)}`;
    });

    await check('the logs of the program exist and carry no secret or password', () => {
      const logs = readdirSync(join(session.dataDir, 'logs'));
      for (const name of ['shell.log', 'api.log', 'worker.log', 'postgres.log']) {
        assert(logs.includes(name), `missing log ${name}`);
      }
      const all = logs
        .map((name) => readFileSync(join(session.dataDir, 'logs', name), 'utf8'))
        .join('\n');
      assert(!all.includes(OWNER.password), 'the owner password is in a log');
      return logs.join(', ');
    });

    await check('make a backup (Consulvia.exe --backup reaches the running instance)', async () => {
      const before = new Set(existsSync(session.backupDir) ? readdirSync(session.backupDir) : []);
      const second = launch(session, ['--backup']);
      await exited(second);
      backupPath = await until(
        'the backup file',
        () => {
          const names = existsSync(session.backupDir)
            ? readdirSync(session.backupDir).filter(
                (name) => name.endsWith('.cvb') && !before.has(name),
              )
            : [];
          return names[0] ? join(session.backupDir, names[0]) : undefined;
        },
        180_000,
      );
      await until(
        'the log line of the backup',
        () => (logText(session).includes('backup created:') ? true : undefined),
        30_000,
      );
      // The backup is encrypted and authenticated: no marker of what is inside shows in the file.
      const { header } = await readArchiveHeader(backupPath);
      assert(
        header.format === 2 && header.kind === 'manual',
        `unexpected header ${JSON.stringify(header)}`,
      );
      const bytes = readFileSync(backupPath);
      for (const marker of ['PGDMP', '%PDF-1.4', 'Clínica Prueba', 'dni-frente', 'COPY ']) {
        assert(!bytes.includes(Buffer.from(marker)), `the backup shows "${marker}" in the clear`);
      }
      // It was opened again after it was written, and the ledger beside the backups says so.
      const ledger = JSON.parse(
        readFileSync(join(session.backupDir, 'registro-de-copias.json'), 'utf8'),
      ) as { files: Record<string, { sha256: string; bytes: number }> };
      const entry = ledger.files[basename(backupPath)];
      assert(
        entry !== undefined && entry.bytes === bytes.length,
        'the backup is not in the ledger of verified backups',
      );
      return `${basename(backupPath)}: ${String(bytes.length)} bytes, encrypted, kind ${header.kind}, verified`;
    });

    await check(
      'create a second patient after the backup (to see the restore take it away)',
      async () => {
        const created = await web.call('POST', '/api/patients', {
          json: {
            familyName: 'Gómez',
            givenNames: 'Juan',
            birthDate: '1990-01-01',
            document: { type: 'dni', number: '31222333' },
            dataProcessingConsent: true,
          },
        });
        assert(
          created.status === 201 || created.status === 200,
          `create answered ${String(created.status)}`,
        );
        const list = await web.call('GET', '/api/patients');
        assert(list.json<{ patients: unknown[] }>().patients.length === 2, 'expected two patients');
        return '2 patients';
      },
    );

    await check(
      'quit through the quit path (Consulvia.exe --quit): no postgres.exe and no child of the app remain',
      async () => {
        const quitter = launch(session, ['--quit']);
        await exited(quitter);
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process of the install to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          240_000,
          1_000,
        );
        const log = logText(session);
        assert(log.includes('database server stopped'), 'PostgreSQL was not stopped with pg_ctl');
        assert(
          !existsSync(join(session.dataDir, 'pgdata', 'postmaster.pid')),
          'postmaster.pid is still there',
        );
        return 'no process left; postmaster.pid removed';
      },
    );

    await check(
      'start again: the data is still there, and the window works (screenshot after login)',
      async () => {
        app = launch(session, ['--remote-debugging-port=9333']);
        await until(
          'the API after the restart',
          () => {
            const count = logText(session).split('api on port').length - 1;
            return count >= 2 ? true : undefined;
          },
          600_000,
        );
        const after = new Client(base, proofOf);
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(login.status === 200, `login after the restart answered ${String(login.status)}`);
        const list = await after.call('GET', '/api/patients');
        assert(
          list.json<{ patients: unknown[] }>().patients.length === 2,
          'the patients did not survive the restart',
        );
        const link = await after.call('POST', `/api/documents/${documentId}/download-link`);
        const download = await after.call('GET', `/api${link.json<{ url: string }>().url}`);
        assert(download.body.equals(PDF), 'the document did not survive the restart');
        web = after;
        const screenshotPath = join(desktopRoot, 'docs', 'screenshot-login.png');
        const probe = await screenshot(
          9333,
          base,
          after,
          OWNER.ownerEmail,
          currentPassword,
          screenshotPath,
        );
        return `2 patients and the PDF survived; screenshot saved (${probe})`;
      },
    );

    await check(
      'a backup that was changed, or planted by someone else, is refused and nothing changes',
      async () => {
        const refusals = () => logText(session).split('restore failed:').length - 1;
        const bytes = Buffer.from(readFileSync(backupPath));
        const middle = Math.floor(bytes.length / 2);
        bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
        const tampered = join(session.root, 'alterada.cvb');
        writeFileSync(tampered, bytes);
        let seen = refusals();
        const tamperedAnswer = await sendKeys(await startRestore(tampered), {
          currentKey: recoveryKey,
        });
        assert(tamperedAnswer.status === 422, 'a changed backup was not refused by the page');
        await until(
          'the refusal of the changed backup',
          () => (refusals() > seen ? true : undefined),
          300_000,
        );
        assert(
          /restore failed: tampered_backup/.test(logText(session)),
          'the changed backup was not refused as tampered',
        );

        // Someone who knows the format and copies the key id of this install, but not its key.
        const { header } = await readArchiveHeader(backupPath);
        const attackerKey = newBackupKey();
        const planted = join(session.root, 'plantada.cvb');
        const writer = createArchiveWriter(planted, attackerKey, {
          ...header,
          fileSalt: randomBytes(32).toString('base64'),
          wrap: wrapBackupKey(attackerKey, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF'),
        });
        await writer.addBuffer('db.dump', "COPY (SELECT 1) TO PROGRAM 'calc.exe';");
        await writer.addBuffer('secrets.json', '{}');
        await writer.addBuffer('manifest.json', '{}');
        await writer.finish();
        seen = refusals();
        const plantedAnswer = await sendKeys(await startRestore(planted), {
          currentKey: recoveryKey,
        });
        assert(plantedAnswer.status === 422, 'a planted backup was not refused by the page');
        await until(
          'the refusal of the planted backup',
          () => (refusals() > seen ? true : undefined),
          300_000,
        );
        assert(
          (logText(session).match(/restore failed: tampered_backup/g) ?? []).length >= 2,
          'the planted backup was not refused as tampered',
        );

        // Nothing was touched: the same two patients and the same document.
        const check = new Client(base, proofOf);
        const login = await check.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(login.status === 200, `login after the refusals answered ${String(login.status)}`);
        const list = await check.call('GET', '/api/patients');
        assert(
          list.json<{ patients: unknown[] }>().patients.length === 2,
          'a refused backup changed the patients',
        );
        return 'both refused as tampered; 2 patients and the data untouched';
      },
    );

    await check(
      'a restore needs the recovery key of THIS install, even for its own backup: without it, or with a wrong one, nothing happens',
      async () => {
        const token = await startRestore(backupPath);
        const page = await new Client(base, proofOf).call('GET', `/__key?t=${token}`);
        assert(page.status === 200, `the keys page answered ${String(page.status)}`);
        assert(
          page.text().includes('name="currentKey"'),
          'the page does not ask for the current key',
        );
        assert(
          !page.text().includes('name="recoveryKey"'),
          'the page asks for the key of a backup that is this install’s own',
        );
        const before = await patientCount();
        const safetyBackups = () => logText(session).split('safety backup before restoring').length;
        const safetyBefore = safetyBackups();
        const none = await sendKeys(token, {});
        assert(none.status === 422, `no key answered ${String(none.status)}`);
        const wrong = await sendKeys(token, { currentKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF' });
        assert(wrong.status === 422, `a wrong key answered ${String(wrong.status)}`);
        // The key of another install is not this one's either.
        const theirs = await sendKeys(token, { currentKey: newBackupKey().toString('hex') });
        assert(theirs.status === 422, `another key answered ${String(theirs.status)}`);
        assert(safetyBackups() === safetyBefore, 'a restore started without the key');
        assert((await patientCount()) === before, 'the data changed without the key');
        // The page gives up after five wrong answers: the address stops working.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await sendKeys(token, { currentKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF' });
        }
        const closed = await sendKeys(token, { currentKey: recoveryKey });
        assert(
          closed.status === 404,
          `after five misses the address answered ${String(closed.status)}`,
        );
        return 'no key, a wrong key and another key were refused; five misses close the page; the data is as it was';
      },
    );

    await check(
      'a backup of ANOTHER install needs both keys: this install’s and the backup’s',
      async () => {
        const foreignKey = newBackupKey();
        const foreignRecovery = 'GGGGG-HHHHH-JJJJJ-KKKKK-LLLLL-MMMMM';
        const { header } = await readArchiveHeader(backupPath);
        const foreign = join(session.root, 'ajena.cvb');
        const writer = createArchiveWriter(foreign, foreignKey, {
          ...header,
          keyId: keyIdOf(foreignKey),
          fileSalt: randomBytes(32).toString('base64'),
          wrap: wrapBackupKey(foreignKey, foreignRecovery),
        });
        // A file that authenticates but whose dump cannot be restored: the keys are all this check is about.
        await writer.addBuffer('db.dump', 'PGDMP-not-a-dump');
        await writer.addBuffer(
          'secrets.json',
          JSON.stringify({
            slug: 'consultorio',
            kmsLocalKekBase64: 'x',
            addressHashPepper: 'x',
            storageUploadSecret: 'x',
            recoveryKeyHash: 'x',
          }),
        );
        await writer.addBuffer('manifest.json', '{}');
        await writer.finish();

        const token = await startRestore(foreign);
        const page = await new Client(base, proofOf).call('GET', `/__key?t=${token}`);
        assert(
          page.text().includes('name="currentKey"') && page.text().includes('name="recoveryKey"'),
          'the page does not ask for both keys',
        );
        const before = await patientCount();
        const onlyMine = await sendKeys(token, { currentKey: recoveryKey });
        assert(onlyMine.status === 422, `only this key answered ${String(onlyMine.status)}`);
        const onlyTheirs = await sendKeys(token, { recoveryKey: foreignRecovery });
        assert(
          onlyTheirs.status === 422,
          `only the backup key answered ${String(onlyTheirs.status)}`,
        );
        const wrongTheirs = await sendKeys(token, {
          currentKey: recoveryKey,
          recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF',
        });
        assert(
          wrongTheirs.status === 422,
          `a wrong backup key answered ${String(wrongTheirs.status)}`,
        );
        const seen = logText(session).split('restore failed:').length - 1;
        // Both right: the keys pass, and the restore itself then fails because the file holds no real dump.
        const both = await sendKeys(token, {
          currentKey: recoveryKey,
          recoveryKey: foreignRecovery,
        });
        assert(both.status === 422, `both keys answered ${String(both.status)}: ${both.text()}`);
        await until(
          'the restore of the file with no dump to fail',
          () => (logText(session).split('restore failed:').length - 1 > seen ? true : undefined),
          300_000,
        );
        assert(
          !/restore failed: (wrong_recovery_key|recovery_key_required)/.test(
            logText(session)
              .split('restore failed:')
              .slice(seen + 1)
              .join('restore failed:'),
          ),
          'with both keys right the restore still asked for a key',
        );
        assert((await patientCount()) === before, 'a failed restore changed the data');
        return 'one key is not enough; a wrong backup key is refused; with both the restore starts (and the data is as it was when it fails)';
      },
    );

    await check(
      'restore the backup (Consulvia.exe --restore=<zip>): the second patient is gone, the first and the PDF remain',
      async () => {
        const count = () => logText(session).split('restore finished').length - 1;
        const before = count();
        const keysAccepted = await sendKeys(await startRestore(backupPath), {
          currentKey: recoveryKey.toLowerCase(),
        });
        assert(
          keysAccepted.status === 200,
          `the right key answered ${String(keysAccepted.status)}: ${keysAccepted.text()}`,
        );
        await until('the restore to finish', () => (count() > before ? true : undefined), 300_000);
        assert(
          readdirSync(session.backupDir).some((name) =>
            name.startsWith('consulvia-previa-restauracion-'),
          ),
          'no safety backup was made before restoring',
        );
        const after = new Client(base, proofOf);
        await until(
          'the API after the restore',
          async () => ((await after.call('GET', '/api/health')).status === 200 ? true : undefined),
          120_000,
        );
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(login.status === 200, `login after the restore answered ${String(login.status)}`);
        const list = await after.call('GET', '/api/patients');
        const patients = list.json<{ patients: unknown[] }>().patients;
        assert(
          patients.length === 1,
          `expected 1 patient after the restore, found ${String(patients.length)}`,
        );
        const link = await after.call('POST', `/api/documents/${documentId}/download-link`);
        const download = await after.call('GET', `/api${link.json<{ url: string }>().url}`);
        assert(download.body.equals(PDF), 'the PDF is not readable after the restore');
        web = after;
        return 'safety backup made; 1 patient; the PDF downloads';
      },
    );

    await check(
      'a restore that was cut off in the middle is undone when Consulvia starts again',
      async () => {
        await exited(launch(session, ['--quit']));
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process of the install to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          240_000,
          1_000,
        );
        // The state a crash leaves after the documents were swapped: the backup's in place, the real ones aside.
        const files = join(session.dataDir, 'files');
        const aside = `${files}.replaced-1`;
        renameSync(files, aside);
        mkdirSync(join(files, 'cut-off'), { recursive: true });
        writeFileSync(join(files, 'cut-off', 'half.obj'), 'half of a restore');
        const unpackedFolder = join(session.dataDir, 'tmp-restore-1');
        mkdirSync(join(unpackedFolder, 'files'), { recursive: true });
        const journal = join(session.dataDir, 'restore-journal.json');
        writeFileSync(
          journal,
          JSON.stringify({
            version: 1,
            stamp: '1',
            step: 'files-swapped',
            filesAside: aside,
            unpacked: unpackedFolder,
            configCopy: null,
            hadFiles: true,
            undoing: false,
          }),
        );
        const starts = logText(session).split('api on port').length - 1;
        app = launch(session);
        await until(
          'the API after the start',
          () => (logText(session).split('api on port').length - 1 > starts ? true : undefined),
          600_000,
        );
        assert(!existsSync(journal), 'the journal of the cut-off restore is still there');
        assert(!existsSync(aside), 'the documents are still aside');
        assert(!existsSync(join(files, 'cut-off')), 'the half restored documents are still there');
        assert(!existsSync(unpackedFolder), 'the work folder of the restore is still there');
        assert(
          logText(session).includes('an interrupted restore was undone'),
          'the log does not say the restore was undone',
        );
        const after = new Client(base, proofOf);
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(login.status === 200, `login after the recovery answered ${String(login.status)}`);
        const link = await after.call('POST', `/api/documents/${documentId}/download-link`);
        const download = await after.call('GET', `/api${link.json<{ url: string }>().url}`);
        assert(download.body.equals(PDF), 'the document is not readable after the recovery');
        web = after;
        return 'journal gone, documents back, the PDF downloads';
      },
    );

    await check(
      'a restore cut off BETWEEN the two renames of the documents (no folder in place, the real ones aside) is undone too',
      async () => {
        await exited(launch(session, ['--quit']));
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process of the install to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          240_000,
          1_000,
        );
        const files = join(session.dataDir, 'files');
        const aside = `${files}.replaced-2`;
        renameSync(files, aside);
        const unpackedFolder = join(session.dataDir, 'tmp-restore-2');
        mkdirSync(join(unpackedFolder, 'files', 'half'), { recursive: true });
        const journal = join(session.dataDir, 'restore-journal.json');
        writeFileSync(
          journal,
          JSON.stringify({
            version: 1,
            stamp: '2',
            step: 'files-swapping',
            filesAside: aside,
            unpacked: unpackedFolder,
            configCopy: null,
            hadFiles: true,
            undoing: false,
          }),
        );
        const starts = logText(session).split('api on port').length - 1;
        app = launch(session);
        await until(
          'the API after the start',
          () => (logText(session).split('api on port').length - 1 > starts ? true : undefined),
          600_000,
        );
        assert(!existsSync(journal), 'the journal of the cut-off restore is still there');
        assert(!existsSync(aside), 'the documents are still aside');
        assert(existsSync(files), 'the documents did not come back');
        assert(!existsSync(unpackedFolder), 'the work folder of the restore is still there');
        const after = new Client(base, proofOf);
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(login.status === 200, `login after the recovery answered ${String(login.status)}`);
        const link = await after.call('POST', `/api/documents/${documentId}/download-link`);
        const download = await after.call('GET', `/api${link.json<{ url: string }>().url}`);
        assert(download.body.equals(PDF), 'the document is not readable after the recovery');
        web = after;
        return 'documents back from aside, journal gone, the PDF downloads';
      },
    );

    await check(
      "reset the owner's password and remove the second factor (the reset page)",
      async () => {
        // A phone enrolls a second factor...
        const start = await web.call('POST', '/api/auth/2fa/enroll/start', { json: {} });
        assert(
          start.status === 200,
          `enroll start answered ${String(start.status)}: ${start.text()}`,
        );
        const secret = start.json<{ secret: string }>().secret;
        const confirm = await web.call('POST', '/api/auth/2fa/enroll/confirm', {
          json: { code: totp(secret) },
        });
        assert(
          confirm.status === 200,
          `enroll confirm answered ${String(confirm.status)}: ${confirm.text()}`,
        );
        const asksCode = new Client(base, proofOf);
        const withFactor = await asksCode.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: OWNER.password },
        });
        assert(
          withFactor.json<{ next: string }>().next === 'totp',
          'with a second factor the sign-in must ask for the code',
        );

        // ...and is lost. The person at the PC resets the password from the tray.
        const before = logText(session).split('reset url:').length - 1;
        await exited(launch(session, ['--reset-password']));
        const resetUrl = await until(
          'the reset address in the log',
          () => {
            const text = logText(session);
            return text.split('reset url:').length - 1 > before
              ? lastMatch(text, /reset url: (\S+)/)
              : undefined;
          },
          60_000,
        );
        const token = new URL(resetUrl).searchParams.get('t') ?? '';
        const page = await new Client(base, proofOf).call('GET', `/__reset?t=${token}`);
        assert(
          page.status === 200 &&
            page.text().includes('Quitar también la verificación en dos pasos'),
          'the reset page is not served',
        );
        assert(
          page.text().includes('name="recoveryKey"'),
          'the reset page does not ask for the recovery key',
        );
        const weak = await new Client(base, proofOf).call('POST', '/__reset', {
          token,
          json: { password: 'corta', passwordConfirmation: 'corta', recoveryKey },
        });
        assert(weak.status === 422, 'a weak password must be refused on the page');
        const newPassword = 'otra frase larga y nueva para entrar';
        // Whoever only has the Windows session cannot take the account over: no key, or a wrong one, is refused.
        const noKey = await new Client(base, proofOf).call('POST', '/__reset', {
          token,
          json: {
            password: newPassword,
            passwordConfirmation: newPassword,
            clearSecondFactor: true,
          },
        });
        assert(noKey.status === 422, `a reset without the key answered ${String(noKey.status)}`);
        const wrongKey = await new Client(base, proofOf).call('POST', '/__reset', {
          token,
          json: {
            password: newPassword,
            passwordConfirmation: newPassword,
            clearSecondFactor: true,
            recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF',
          },
        });
        assert(
          wrongKey.status === 422,
          `a reset with a wrong key answered ${String(wrongKey.status)}`,
        );
        const stillOld = await new Client(base, proofOf).call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(stillOld.status !== 401, 'a refused reset changed the password');
        const reset = await new Client(base, proofOf).call('POST', '/__reset', {
          token,
          json: {
            password: newPassword,
            passwordConfirmation: newPassword,
            clearSecondFactor: true,
            recoveryKey: recoveryKey.toLowerCase(),
          },
        });
        assert(reset.status === 200, `reset answered ${String(reset.status)}: ${reset.text()}`);
        assert(
          reset.json<{ secondFactorCleared: boolean }>().secondFactorCleared,
          'the second factor was not cleared',
        );

        const second = await new Client(base, proofOf).call('POST', '/__reset', {
          token,
          json: { password: newPassword, passwordConfirmation: newPassword, recoveryKey },
        });
        assert(second.status === 404, 'the reset address must stop working once it was used');
        const old = await new Client(base, proofOf).call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: currentPassword },
        });
        assert(old.status === 401, `the old password must stop working, got ${String(old.status)}`);
        const fresh = await new Client(base, proofOf).call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: newPassword },
        });
        assert(
          fresh.status === 200 && fresh.json<{ next: string }>().next !== 'totp',
          `the new password must sign in without a code: ${fresh.text()}`,
        );
        const sessionEnded = await web.call('GET', '/api/auth/me');
        assert(sessionEnded.status === 401, 'the sessions of the owner must end with a reset');
        // The owner is told, in the outbox, that the password was reset from this PC.
        const outbox = join(session.dataDir, 'outbox');
        const notices = readdirSync(outbox)
          .filter((name) => name.endsWith('.json'))
          .map(
            (name) =>
              JSON.parse(readFileSync(join(outbox, name), 'utf8')) as {
                to: string;
                subject: string;
              },
          )
          .filter((entry) => entry.subject.includes('se restableció la contraseña'));
        assert(
          notices.some((entry) => entry.to === OWNER.ownerEmail),
          'no notice for the owner in the outbox',
        );
        currentPassword = newPassword;
        return 'new password works, no code asked, old password and old session refused; the owner has a notice';
      },
    );

    if (upgradeTo !== undefined && unpacked === undefined) {
      await check(
        'install the next version over the running one: it quits by itself and the data survives',
        async () => {
          assert(existsSync(upgradeTo), `no installer at ${upgradeTo}`);
          const nextVersion = /Consulvia-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(upgradeTo)?.[1];
          assert(nextVersion !== undefined, 'the name of the new installer carries no version');
          assert(nextVersion !== manifest.version, 'the new installer has the same version');
          assert(leftovers(session).length > 0, 'the program is not running before the upgrade');
          const logBefore = logText(session).length;
          const setup = spawn(upgradeTo, ['/S', `/D=${session.installDir}`], {
            env: session.env,
            stdio: 'ignore',
          });
          const code = await Promise.race([
            exited(setup),
            sleep(480_000).then(() => 'timeout' as const),
          ]);
          assert(code === 0, `the installer of the new version ended with ${String(code)}`);
          // The running program went through its own way out, not through taskkill.
          const added = logText(session).slice(logBefore);
          assert(
            added.includes('database server stopped') && /\sstopped\n/.test(added),
            'the running program was not stopped through its own way out',
          );
          const productVersion = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-Item '${session.exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
            ],
            { encoding: 'utf8' },
          ).stdout.trim();
          assert(
            productVersion.startsWith(nextVersion),
            `Consulvia.exe is version ${productVersion}, not ${nextVersion}`,
          );
          // The one-click installer starts the new program when it finishes; if it did not, start it.
          await sleep(6_000);
          if (!logText(session).slice(logBefore).includes(`starting Consulvia ${nextVersion}`)) {
            app = launch(session);
          }
          await until(
            'the new version to start',
            () =>
              logText(session).slice(logBefore).includes(`starting Consulvia ${nextVersion}`)
                ? true
                : undefined,
            300_000,
          );
          const after = new Client(base, proofOf);
          await until(
            'the API of the new version',
            async () => {
              try {
                return (await after.call('GET', '/api/health')).status === 200 ? true : undefined;
              } catch {
                return undefined;
              }
            },
            600_000,
          );
          const login = await after.call('POST', '/api/auth/login', {
            json: { email: OWNER.ownerEmail, password: currentPassword },
          });
          assert(login.status === 200, `login after the upgrade answered ${String(login.status)}`);
          const list = await after.call('GET', '/api/patients');
          assert(
            list.json<{ patients: unknown[] }>().patients.length === 1,
            'the patients did not survive the upgrade',
          );
          const link = await after.call('POST', `/api/documents/${documentId}/download-link`);
          const download = await after.call('GET', `/api${link.json<{ url: string }>().url}`);
          assert(download.body.equals(PDF), 'the document did not survive the upgrade');
          web = after;
          return `${manifest.version} -> ${nextVersion} over the running program; 1 patient and the PDF survived`;
        },
      );
    }

    await check(
      'quit again, then uninstall silently: the data folder and the backups stay',
      async () => {
        await exited(launch(session, ['--quit']));
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          240_000,
          1_000,
        );

        if (unpacked === undefined) {
          const uninstaller = join(session.installDir, 'Uninstall Consulvia.exe');
          assert(existsSync(uninstaller), 'no uninstaller in the install folder');
          await exited(spawn(uninstaller, ['/S'], { env: session.env, stdio: 'ignore' }));
          await until(
            'the program files to be removed',
            () => (existsSync(session.exe) ? undefined : true),
            120_000,
            1_000,
          );
        }
        assert(
          existsSync(join(session.dataDir, 'config.json')),
          'config.json was removed with the program',
        );
        assert(
          existsSync(join(session.dataDir, 'pgdata', 'PG_VERSION')),
          'pgdata was removed with the program',
        );
        assert(
          readdirSync(session.backupDir).some((name) => name.endsWith('.cvb')),
          'the backups were removed with the program',
        );
        return 'program removed; config.json, pgdata and the backups kept';
      },
    );
  } finally {
    // After a failure the program may still be running: ask it to stop the way a user would, first.
    if (existsSync(session.exe) && leftovers(session).length > 0) {
      await exited(launch(session, ['--quit']));
      await until(
        'the program to stop',
        () => (leftovers(session).length === 0 ? true : undefined),
        60_000,
        1_000,
      ).catch(() => undefined);
    }
    const stray = leftovers(session);
    if (stray.length > 0) {
      console.log(
        `cleaning up ${String(stray.length)} process(es) of this test: ${stray.map((entry) => `${entry.name} ${String(entry.pid)}`).join(', ')}`,
      );
      for (const entry of stray) {
        try {
          process.kill(entry.pid);
        } catch {
          // Already gone.
        }
      }
      await sleep(2_000);
    }
    // An install that is still there (a step failed before the uninstall) would leave its shortcuts behind.
    const uninstaller = join(session.installDir, 'Uninstall Consulvia.exe');
    if (existsSync(uninstaller)) {
      await exited(spawn(uninstaller, ['/S'], { env: session.env, stdio: 'ignore' }));
      await until(
        'the leftover install to be removed',
        () => (existsSync(session.exe) ? undefined : true),
        120_000,
        1_000,
      ).catch(() => undefined);
    }
    writeFileSync(
      join(desktopRoot, 'build', 'verify-report.json'),
      `${JSON.stringify({ installer, root, version: manifest.version, results }, null, 2)}\n`,
    );
    if (process.argv.includes('--keep')) console.log(`kept: ${root}`);
    else await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

try {
  await main();
  console.log(`\nAll ${String(results.length)} checks passed.`);
} catch {
  console.log(
    `\n${String(results.filter((entry) => entry.ok).length)} of ${String(results.length)} checks passed.`,
  );
  process.exitCode = 1;
}
