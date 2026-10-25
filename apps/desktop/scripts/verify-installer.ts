import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listZipNames } from '../src/zip.js';

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
  constructor(readonly base: URL) {}

  call(
    method: string,
    path: string,
    options: {
      json?: unknown;
      body?: Buffer;
      headers?: Record<string, string>;
      token?: string;
    } = {},
  ): Promise<Reply> {
    const payload =
      options.body ??
      (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)));
    const headers: Record<string, string> = {
      host: this.base.host,
      origin: this.base.origin,
      ...(payload && options.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(payload ? { 'content-length': String(payload.length) } : {}),
      ...(options.token ? { 'x-consulvia-token': options.token } : {}),
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
    `$root = '${session.root.replaceAll("'", "''")}'; ` +
    `Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase')) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ` +
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
  const installer =
    process.argv[2] ?? join(desktopRoot, 'release', `Consulvia-Setup-${manifest.version}.exe`);
  assert(existsSync(installer), `no installer at ${installer}`);

  const root = await mkdtemp(join(tmpdir(), 'consulvia-verify-'));
  const session: Session = {
    root,
    installDir: join(root, 'programa'),
    dataDir: join(root, 'datos'),
    backupDir: join(root, 'copias'),
    exe: join(root, 'programa', 'Consulvia.exe'),
    shellLog: join(root, 'datos', 'logs', 'shell.log'),
    env: {
      ...process.env,
      CONSULVIA_DATA_DIR: join(root, 'datos'),
      CONSULVIA_BACKUP_DIR: join(root, 'copias'),
      CONSULVIA_TEST_MODE: '1',
    },
  };
  console.log(`installer: ${installer}\nfolder:    ${root}\n`);

  let app: ChildProcess | undefined;
  let base!: URL;
  let web!: Client;
  let patientId = '';
  let documentId = '';
  let backupPath = '';

  try {
    await check('install silently into a temporary folder (/S)', async () => {
      const setup = spawn(installer, ['/S', `/D=${session.installDir}`], {
        env: session.env,
        stdio: 'ignore',
      });
      const code = await exited(setup);
      assert(code === 0, `the installer exited with ${String(code)}`);
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
          240_000,
        );
        const parsed = new URL(url);
        base = new URL(parsed.origin);
        web = new Client(base);
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
      'set up "Clínica Prueba" with an owner (POST /__setup with the one-time token)',
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
        const body = answer.json<{ ok: boolean; recoveryKey: string }>();
        assert(
          body.ok && /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/.test(body.recoveryKey),
          'no recovery key in the answer',
        );
        const gone = await web.call('GET', `/__setup?t=${token}`);
        assert(gone.status === 404, 'the setup page must be 404 once the organization exists');
        return 'recovery key shown; /__setup is now 404';
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
      patientId = created.json<{ id: string }>().id;
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
          90_000,
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
        90_000,
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
        'the backup zip',
        () => {
          const names = existsSync(session.backupDir)
            ? readdirSync(session.backupDir).filter(
                (name) => name.endsWith('.zip') && !before.has(name),
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
      const names = await listZipNames(backupPath);
      for (const required of ['meta.json', 'recovery.json', 'db.dump'])
        assert(names.includes(required), `${required} is not in the backup`);
      assert(
        names.some((name) => name.startsWith('files/') && name.endsWith('.obj')),
        'the uploaded PDF is not in the backup',
      );
      return `${backupPath.split('\\').pop() ?? ''}: ${String(names.length)} entries`;
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
          90_000,
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
          240_000,
        );
        const after = new Client(base);
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: OWNER.password },
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
          OWNER.password,
          screenshotPath,
        );
        return `2 patients and the PDF survived; screenshot saved (${probe})`;
      },
    );

    await check(
      'restore the backup (Consulvia.exe --restore=<zip>): the second patient is gone, the first and the PDF remain',
      async () => {
        const count = () => logText(session).split('restore finished').length - 1;
        const before = count();
        const second = launch(session, [`--restore=${backupPath}`]);
        await exited(second);
        await until('the restore to finish', () => (count() > before ? true : undefined), 300_000);
        assert(
          readdirSync(session.backupDir).some((name) =>
            name.startsWith('consulvia-previa-restauracion-'),
          ),
          'no safety backup was made before restoring',
        );
        const after = new Client(base);
        await until(
          'the API after the restore',
          async () => ((await after.call('GET', '/api/health')).status === 200 ? true : undefined),
          120_000,
        );
        const login = await after.call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: OWNER.password },
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
        const asksCode = new Client(base);
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
        const page = await new Client(base).call('GET', `/__reset?t=${token}`);
        assert(
          page.status === 200 &&
            page.text().includes('Quitar también la verificación en dos pasos'),
          'the reset page is not served',
        );
        const weak = await new Client(base).call('POST', '/__reset', {
          token,
          json: { password: 'corta', passwordConfirmation: 'corta' },
        });
        assert(weak.status === 422, 'a weak password must be refused on the page');
        const newPassword = 'otra frase larga y nueva para entrar';
        const reset = await new Client(base).call('POST', '/__reset', {
          token,
          json: {
            password: newPassword,
            passwordConfirmation: newPassword,
            clearSecondFactor: true,
          },
        });
        assert(reset.status === 200, `reset answered ${String(reset.status)}: ${reset.text()}`);
        assert(
          reset.json<{ secondFactorCleared: boolean }>().secondFactorCleared,
          'the second factor was not cleared',
        );

        const old = await new Client(base).call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: OWNER.password },
        });
        assert(old.status === 401, `the old password must stop working, got ${String(old.status)}`);
        const fresh = await new Client(base).call('POST', '/api/auth/login', {
          json: { email: OWNER.ownerEmail, password: newPassword },
        });
        assert(
          fresh.status === 200 && fresh.json<{ next: string }>().next !== 'totp',
          `the new password must sign in without a code: ${fresh.text()}`,
        );
        const sessionEnded = await web.call('GET', '/api/auth/me');
        assert(sessionEnded.status === 401, 'the sessions of the owner must end with a reset');
        return 'new password works, no code asked, old password and old session refused';
      },
    );

    await check(
      'quit again, then uninstall silently: the data folder and the backups stay',
      async () => {
        await exited(launch(session, ['--quit']));
        if (app) await Promise.race([exited(app), sleep(60_000)]);
        await until(
          'every process to end',
          () => (leftovers(session).length === 0 ? true : undefined),
          90_000,
          1_000,
        );

        const uninstaller = join(session.installDir, 'Uninstall Consulvia.exe');
        assert(existsSync(uninstaller), 'no uninstaller in the install folder');
        await exited(spawn(uninstaller, ['/S'], { env: session.env, stdio: 'ignore' }));
        await until(
          'the program files to be removed',
          () => (existsSync(session.exe) ? undefined : true),
          120_000,
          1_000,
        );
        assert(
          existsSync(join(session.dataDir, 'config.json')),
          'config.json was removed with the program',
        );
        assert(
          existsSync(join(session.dataDir, 'pgdata', 'PG_VERSION')),
          'pgdata was removed with the program',
        );
        assert(
          readdirSync(session.backupDir).some((name) => name.endsWith('.zip')),
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
