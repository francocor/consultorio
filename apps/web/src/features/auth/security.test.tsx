import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { describeUserAgent } from './describe-user-agent.js';

const CODES = Array.from({ length: 10 }, (_, index) => `CODE-${String(index).padStart(4, '0')}`);

const SESSIONS = {
  sessions: [
    {
      id: '0190a000-0000-7000-8000-0000000000a1',
      createdAt: '2026-10-16T10:00:00.000Z',
      lastSeenAt: '2026-10-16T12:30:00.000Z',
      expiresAt: '2026-10-23T10:00:00.000Z',
      ip: '203.0.113.7',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      current: true,
    },
    {
      id: '0190a000-0000-7000-8000-0000000000a2',
      createdAt: '2026-10-15T08:00:00.000Z',
      lastSeenAt: '2026-10-15T09:15:00.000Z',
      expiresAt: '2026-10-22T08:00:00.000Z',
      ip: null,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      current: false,
    },
  ],
};

function open(
  me = meFor(['reception'], {
    twoFactor: { enrolled: false, required: false, graceEndsAt: null },
  }),
  routes: Record<string, (url: string, init: RequestInit) => Response> = {},
) {
  return renderApp({
    me,
    path: '/account/security',
    boot: bootFor(),
    routes: {
      'GET /api/auth/sessions': () => jsonResponse(SESSIONS),
      ...routes,
    },
  });
}

describe('describeUserAgent', () => {
  it.each([
    [SESSIONS.sessions[0]?.userAgent ?? '', { browser: 'Chrome', os: 'Windows' }],
    [SESSIONS.sessions[1]?.userAgent ?? '', { browser: 'Safari', os: 'iPhone' }],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      { browser: 'Firefox', os: 'Linux' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      { browser: 'Safari', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
      { browser: 'Edge', os: 'Windows' },
    ],
  ])('turns %s into a browser and a system', (userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toEqual(expected);
  });

  it('does not invent a device when it cannot tell', () => {
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent('curl/8.0')).toBeNull();
  });
});

describe('second factor: enrolling', () => {
  it('walks through scanning, confirming and keeping the recovery codes', async () => {
    const user = userEvent.setup();
    let confirmed: unknown;
    const app = open(undefined, {
      'POST /api/auth/2fa/enroll/start': () =>
        jsonResponse({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Consultorio:ana?secret=JBSWY3DPEHPK3PXP&issuer=Consultorio',
        }),
      'POST /api/auth/2fa/enroll/confirm': (_url, init) => {
        confirmed = jsonBody(init);
        return jsonResponse({ recoveryCodes: CODES });
      },
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Seguridad de la cuenta' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Desactivada')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activar la verificación' }));

    expect(
      await screen.findByRole('img', { name: 'Código QR para la aplicación de autenticación' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Código de verificación'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar y activar' }));

    const list = await screen.findByRole('list', { name: 'Lista de códigos de recuperación' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('CODE-0003')).toBeInTheDocument();
    expect(confirmed).toEqual({ code: '123456' });
    expect(screen.getByText(/No volverán a mostrarse/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('copies the recovery codes and offers them as a text file', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:codes');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    open(undefined, {
      'POST /api/auth/2fa/enroll/start': () =>
        jsonResponse({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
        }),
      'POST /api/auth/2fa/enroll/confirm': () => jsonResponse({ recoveryCodes: CODES }),
    });
    await user.click(await screen.findByRole('button', { name: 'Activar la verificación' }));
    await user.type(await screen.findByLabelText('Código de verificación'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar y activar' }));

    await user.click(await screen.findByRole('button', { name: 'Copiar los códigos' }));
    expect(await navigator.clipboard.readText()).toBe(CODES.join('\n'));
    expect(await screen.findByText('Códigos copiados')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Descargar como archivo de texto' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('a wrong code keeps the person on the step with a clear message', async () => {
    const user = userEvent.setup();
    open(undefined, {
      'POST /api/auth/2fa/enroll/start': () =>
        jsonResponse({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
        }),
      'POST /api/auth/2fa/enroll/confirm': () => problemResponse(400, 'bad_request'),
    });
    await user.click(await screen.findByRole('button', { name: 'Activar la verificación' }));
    await user.type(await screen.findByLabelText('Código de verificación'), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirmar y activar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El código no es correcto');
    expect(screen.getByLabelText('Código de verificación')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Lista de códigos de recuperación' }),
    ).not.toBeInTheDocument();
  });

  it('a session that can only enroll is told why, and goes to the start page once the codes are saved', async () => {
    const user = userEvent.setup();
    // The server upgrades the session when the factor is confirmed.
    let upgraded = false;
    const app = open(
      meFor(['professional'], {
        scope: 'two_factor_enrollment',
        twoFactor: { enrolled: false, required: true, graceEndsAt: null },
      }),
      {
        'GET /api/auth/me': () =>
          jsonResponse(
            upgraded
              ? meFor(['professional'])
              : meFor(['professional'], {
                  scope: 'two_factor_enrollment',
                  twoFactor: { enrolled: false, required: true, graceEndsAt: null },
                }),
          ),
        'POST /api/auth/2fa/enroll/start': () =>
          jsonResponse({
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
          }),
        'POST /api/auth/2fa/enroll/confirm': () => {
          upgraded = true;
          return jsonResponse({ recoveryCodes: CODES });
        },
      },
    );

    expect(await screen.findByText('Active la verificación en dos pasos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activar la verificación' }));
    await user.type(await screen.findByLabelText('Código de verificación'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar y activar' }));
    await user.click(await screen.findByRole('button', { name: 'Ya los guardé' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/');
    });
  });
});

describe('second factor: already enrolled', () => {
  const enrolled = meFor(['reception'], {
    twoFactor: { enrolled: true, required: false, graceEndsAt: null },
  });

  it('changing the device asks for the password first, and a wrong one is not a sign-out', async () => {
    const user = userEvent.setup();
    const app = open(enrolled, {
      'POST /api/auth/2fa/enroll/start': () => problemResponse(401, 'unauthenticated'),
    });
    expect(await screen.findByText('Activada')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cambiar de dispositivo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirme su contraseña' });
    await user.type(within(dialog).getByLabelText('Contraseña'), 'incorrecta');
    await user.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'La contraseña no es correcta',
    );
    expect(app.router.state.location.pathname).toBe('/account/security');
  });

  it('can turn the factor off when the role does not require it, with the password', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const app = open(enrolled, {
      'POST /api/auth/2fa/disable': (_url, init) => {
        body = jsonBody(init);
        return new Response(null, { status: 204 });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Contraseña'), 'mi-clave-actual');
    await user.click(within(dialog).getByRole('button', { name: 'Desactivar la verificación' }));

    await waitFor(() => {
      expect(body).toEqual({ password: 'mi-clave-actual' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(app.requests).toContain('POST /api/auth/2fa/disable');
  });

  it('a mandatory role can replace the factor but never remove it', async () => {
    open(
      meFor(['professional'], { twoFactor: { enrolled: true, required: true, graceEndsAt: null } }),
    );

    expect(await screen.findByText('Activada')).toBeInTheDocument();
    expect(screen.getByText(/Su rol requiere la verificación en dos pasos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambiar de dispositivo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
  });

  it('generates new recovery codes after confirming the password', async () => {
    const user = userEvent.setup();
    open(enrolled, {
      'POST /api/auth/2fa/recovery-codes': () => jsonResponse({ recoveryCodes: CODES }),
    });
    await user.click(await screen.findByRole('button', { name: 'Generar códigos nuevos' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Contraseña'), 'mi-clave-actual');
    await user.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    const list = await screen.findByRole('list', { name: 'Lista de códigos de recuperación' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });
});

describe('open sessions', () => {
  it('lists the devices, marks the current one and only offers to close the others', async () => {
    open();

    const current = await screen.findByText('Chrome en Windows');
    expect(current).toBeInTheDocument();
    expect(screen.getByText('Safari en iPhone')).toBeInTheDocument();
    expect(screen.getByText('Esta sesión')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cerrar esta sesión' })).toHaveLength(1);
    expect(screen.getByText(/Dirección: 203\.0\.113\.7/)).toBeInTheDocument();
  });

  it('closes another session and refreshes the list', async () => {
    const user = userEvent.setup();
    let closed = false;
    const app = open(undefined, {
      'GET /api/auth/sessions': () =>
        jsonResponse(closed ? { sessions: SESSIONS.sessions.slice(0, 1) } : SESSIONS),
      'DELETE /api/auth/sessions/0190a000-0000-7000-8000-0000000000a2': () => {
        closed = true;
        return new Response(null, { status: 204 });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Cerrar esta sesión' }));

    await waitFor(() => {
      expect(screen.queryByText('Safari en iPhone')).not.toBeInTheDocument();
    });
    expect(app.requests).toContain(
      'DELETE /api/auth/sessions/0190a000-0000-7000-8000-0000000000a2',
    );
    expect(await screen.findByText('No hay otras sesiones abiertas')).toBeInTheDocument();
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    open(undefined, {
      'GET /api/auth/sessions': () =>
        fail ? problemResponse(500, 'internal_error') : jsonResponse(SESSIONS),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Código de referencia');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Chrome en Windows')).toBeInTheDocument();
  });

  it('the whole page has no accessibility violations', async () => {
    const app = open();
    await screen.findByText('Chrome en Windows');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
