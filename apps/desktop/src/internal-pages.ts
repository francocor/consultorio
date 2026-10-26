import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  PAGE_CSP,
  PAGE_CSS,
  PAGE_JS,
  renderCheckPage,
  renderKeyPage,
  type RestoreKeyNeeds,
  renderRegeneratePage,
  renderResetPage,
  renderSetupPage,
} from './pages.js';
import type { FieldErrors, SetupValues } from './setup-validation.js';
import { validateNewPassword, validateSetup } from './setup-validation.js';
import type { TokenVault } from './tokens.js';
import { BROWSER_COOKIE } from './window-proof.js';

export type SetupOutcome =
  | {
      ok: true;
      recoveryKey: string;
      /** Lets the page that shows the key confirm it, after the setup token is gone. */
      ackToken: string;
    }
  | { ok: false; errors?: FieldErrors; message?: string };

/** A new recovery key made for an install, shown and waiting to be confirmed; or why not. */
export type RegenerateOutcome =
  | { ok: true; recoveryKey: string; ackToken: string }
  | { ok: false; errors?: Record<string, string>; message?: string };

export type ResetOutcome =
  | { ok: true; email: string; secondFactorCleared: boolean }
  | { ok: false; errors?: Record<string, string>; message?: string };

export type KeyOutcome = { ok: true } | { ok: false; message: string };

export type ConfirmOutcome =
  | { ok: true }
  | {
      ok: false;
      errors?: Record<string, string>;
      message?: string;
      /** The page goes back to its form: what was asked could not be done with what was typed there. */
      back?: boolean;
    };

/** What the pages do. The shell implements these; this module only speaks HTTP. */
export interface PageActions {
  /** True once the organization exists: the setup page is then a 404 for good. */
  isProvisioned(): boolean;
  commonPasswords(): ReadonlySet<string>;
  /** Creates the organization and starts the API and the worker. Resolves when the app is ready to open. */
  setup(values: SetupValues): Promise<SetupOutcome>;
  /**
   * Gives the owner a new password (and, when asked, removes the second factor). The recovery key typed on
   * the page proves that whoever asks holds the key and not only the Windows session; the shell checks it.
   */
  resetPassword(input: {
    newPassword: string;
    clearSecondFactor: boolean;
    recoveryKey: string;
  }): Promise<ResetOutcome>;
  /** Which keys the restore that is waiting asks for. */
  restoreKeyNeeds(): RestoreKeyNeeds;
  /** The keys typed for the restore that is waiting: this install's, and the backup's when it comes from another one. */
  submitRecoveryKey(keys: { current: string; backup: string }): Promise<ConfirmOutcome>;
  /**
   * The owner typed the last four characters of the key that the setup page just showed: it is confirmed. Only
   * possible in the run that made the key, because the key is not kept anywhere else.
   */
  confirmRecoveryKey(lastFour: string): Promise<ConfirmOutcome>;
  /** Tells whether a recovery key typed from the paper copy is the one of this install. */
  checkRecoveryKey(typed: string): Promise<ConfirmOutcome>;
  /** The value the browser of the PC keeps as its proof once the owner opened the program there. */
  browserSession(): string;
  /**
   * A new recovery key for an install that never confirmed its key, once the API has accepted the password (and the
   * code of the second factor) of an owner. Like the setup, it only shows the key: the confirmation makes it count.
   */
  regenerateRecoveryKey(input: {
    email: string;
    password: string;
    code: string;
  }): Promise<RegenerateOutcome>;
}

export const PURPOSE = {
  setup: 'setup',
  reset: 'reset',
  key: 'key',
  ack: 'ack',
  check: 'check',
  browser: 'browser',
  regenerate: 'regenerate',
} as const;

const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': PAGE_CSP,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  response.end(JSON.stringify(body));
}

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  response.end('No encontrado');
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  response.end(html);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const PAGES: Record<string, { purpose: string; render: (actions: PageActions) => string | null }> =
  {
    '/__setup': { purpose: PURPOSE.setup, render: renderSetupPage },
    '/__reset': { purpose: PURPOSE.reset, render: renderResetPage },
    '/__key': {
      purpose: PURPOSE.key,
      render: (actions) => renderKeyPage(actions.restoreKeyNeeds()),
    },
    // Only an answer (POST) lives here: the key is shown once, by the setup page, and no page shows it again.
    '/__ack': { purpose: PURPOSE.ack, render: () => null },
    '/__check': { purpose: PURPOSE.check, render: renderCheckPage },
    '/__regen': { purpose: PURPOSE.regenerate, render: renderRegeneratePage },
  };

/**
 * The pages of the shell. A page is shown only with its token, and the setup page only while the
 * organization does not exist. An action is accepted only as a JSON POST with the token in a header, from
 * the origin of the page itself: a form on another site cannot send that header without the browser
 * asking this server first, and this server never answers that question.
 */
export function createInternalPages(vault: TokenVault, actions: PageActions) {
  /** Purposes with an action running: a second click (or a second program) must not start it again. */
  const running = new Set<string>();

  function allowed(purpose: string): boolean {
    return purpose !== PURPOSE.setup || !actions.isProvisioned();
  }

  function sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return origin === undefined || origin === `http://${request.headers.host ?? ''}`;
  }

  async function handleAction(
    purpose: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const token = request.headers['x-consulvia-token'];
    if (
      !allowed(purpose) ||
      !sameOrigin(request) ||
      !vault.verify(purpose, typeof token === 'string' ? token : undefined)
    ) {
      sendNotFound(response);
      return;
    }
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
      sendJson(response, 415, { ok: false, message: 'Solicitud no válida.' });
      return;
    }
    if (running.has(purpose)) {
      sendJson(response, 409, {
        ok: false,
        message: 'Hay una operación en curso. Espere unos segundos.',
      });
      return;
    }
    running.add(purpose);
    try {
      await runAction(purpose, request, response);
    } finally {
      running.delete(purpose);
    }
  }

  async function runAction(
    purpose: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      sendJson(response, 400, { ok: false, message: 'Solicitud no válida.' });
      return;
    }

    if (purpose === PURPOSE.setup) {
      const checked = validateSetup(body, actions.commonPasswords());
      if (!checked.ok) {
        sendJson(response, 422, { ok: false, errors: checked.errors });
        return;
      }
      const outcome = await actions.setup(checked.value);
      sendJson(response, outcome.ok ? 200 : 422, outcome);
      return;
    }

    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (purpose === PURPOSE.reset) {
      const typedKey = typeof input['recoveryKey'] === 'string' ? input['recoveryKey'] : '';
      if (typedKey.trim() === '') {
        sendJson(response, 422, {
          ok: false,
          errors: { recoveryKey: 'Ingrese la clave de recuperación.' },
        });
        return;
      }
      const checked = validateNewPassword(
        input['password'],
        input['passwordConfirmation'],
        '',
        actions.commonPasswords(),
      );
      if (!checked.ok) {
        sendJson(response, 422, { ok: false, errors: checked.errors });
        return;
      }
      const outcome = await actions.resetPassword({
        newPassword: checked.value,
        clearSecondFactor: input['clearSecondFactor'] === true,
        recoveryKey: typedKey,
      });
      const answer = outcome.ok
        ? {
            ...outcome,
            secondFactorNote: outcome.secondFactorCleared
              ? 'También se quitó la verificación en dos pasos: la propietaria puede volver a activarla desde su cuenta.'
              : '',
          }
        : outcome;
      sendJson(response, outcome.ok ? 200 : 422, answer);
      return;
    }

    if (purpose === PURPOSE.ack) {
      const lastFour =
        typeof input['recoveryKeyLast4'] === 'string' ? input['recoveryKeyLast4'] : '';
      if (lastFour.trim().length < 4) {
        sendJson(response, 422, {
          ok: false,
          errors: { recoveryKeyLast4: 'Escriba los últimos 4 caracteres de la clave.' },
        });
        return;
      }
      const outcome = await actions.confirmRecoveryKey(lastFour);
      sendJson(response, outcome.ok ? 200 : 422, outcome);
      return;
    }

    if (purpose === PURPOSE.regenerate) {
      const text = (name: string) => (typeof input[name] === 'string' ? input[name] : '');
      if (text('email').trim() === '' || text('password') === '') {
        sendJson(response, 422, {
          ok: false,
          errors: { password: 'Ingrese el correo y la contraseña de la propietaria.' },
        });
        return;
      }
      const outcome = await actions.regenerateRecoveryKey({
        email: text('email').trim(),
        password: text('password'),
        code: text('code'),
      });
      sendJson(response, outcome.ok ? 200 : 422, outcome);
      return;
    }

    const key = typeof input['recoveryKey'] === 'string' ? input['recoveryKey'] : '';
    if (purpose === PURPOSE.check) {
      if (key.trim() === '') {
        sendJson(response, 422, {
          ok: false,
          errors: { recoveryKey: 'Ingrese la clave de recuperación.' },
        });
        return;
      }
      const outcome = await actions.checkRecoveryKey(key);
      sendJson(response, outcome.ok ? 200 : 422, outcome);
      return;
    }
    // Which of the two keys is missing is for the restore to say: it knows which ones it asked for.
    const current = typeof input['currentKey'] === 'string' ? input['currentKey'] : '';
    const outcome = await actions.submitRecoveryKey({ current, backup: key });
    sendJson(response, outcome.ok ? 200 : 422, outcome);
  }

  /** Answers the request and returns true when the path is one of the shell's own; false lets it go on. */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/__assets/page.css' || path === '/__assets/page.js') {
      response.writeHead(200, {
        'Content-Type': path.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/javascript; charset=utf-8',
        ...SECURITY_HEADERS,
      });
      response.end(path.endsWith('.css') ? PAGE_CSS : PAGE_JS);
      return true;
    }
    if (path === '/__browser') {
      // The way into the program from the browser of the PC: an address that works once, for a minute, and
      // leaves the browser with a cookie that no script of a page can read.
      const valid =
        (request.method === 'GET' || request.method === 'HEAD') &&
        vault.verify(PURPOSE.browser, url.searchParams.get('t'));
      if (!valid) {
        sendNotFound(response);
        return true;
      }
      vault.revoke(PURPOSE.browser);
      response.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${BROWSER_COOKIE}=${actions.browserSession()}; Path=/; HttpOnly; SameSite=Strict`,
        ...SECURITY_HEADERS,
      });
      response.end();
      return true;
    }
    const page = PAGES[path];
    if (!page) return false;
    if (request.method === 'POST') {
      await handleAction(page.purpose, request, response);
      return true;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, POST', ...SECURITY_HEADERS });
      response.end();
      return true;
    }
    if (!allowed(page.purpose) || !vault.verify(page.purpose, url.searchParams.get('t'))) {
      sendNotFound(response);
      return true;
    }
    const html = page.render(actions);
    if (html === null) sendNotFound(response);
    else sendHtml(response, html);
    return true;
  }

  return { handle };
}

export type InternalPages = ReturnType<typeof createInternalPages>;
