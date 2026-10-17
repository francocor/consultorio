import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { bodyText, jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

const reception = meFor(['reception']);

/** An app whose `/auth/me` answers 401 until the sign-in call succeeds. */
type Handler = (url: string, init: RequestInit) => Response;

function appWithSignIn(path: string, routes: Record<string, Handler> = {}) {
  const state = { signedIn: false };
  const app = renderApp({
    me: null,
    path,
    boot: bootFor('Clínica Norte'),
    routes: {
      'GET /api/auth/me': () =>
        state.signedIn ? jsonResponse(reception) : problemResponse(401, 'unauthenticated'),
      'POST /api/auth/login': () => {
        state.signedIn = true;
        return jsonResponse({ next: 'authenticated' });
      },
      'POST /api/auth/2fa': () => {
        state.signedIn = true;
        return jsonResponse({ next: 'authenticated' });
      },
      ...routes,
    },
  });
  return { app, state };
}

async function fillLogin(
  user: ReturnType<typeof userEvent.setup>,
  password = 'una-clave-larga-123',
) {
  await user.type(await screen.findByLabelText('Correo electrónico'), 'ana.perez@example.test');
  await user.type(screen.getByLabelText('Contraseña'), password);
  await user.click(screen.getByRole('button', { name: 'Ingresar' }));
}

describe('sign in', () => {
  it('signs in and lands on the start page of the organization', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/login');
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(await screen.findByText(/acceder a Clínica Norte/)).toBeInTheDocument();

    await fillLogin(user);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bienvenido a Clínica Norte' }),
    ).toBeInTheDocument();
    expect(app.requests).toContain('POST /api/auth/login');
    expect(app.missingKeys).toEqual([]);
  });

  it('shows one generic message for any wrong credential and keeps the email', async () => {
    const user = userEvent.setup();
    appWithSignIn('/login', {
      'POST /api/auth/login': () => problemResponse(401, 'unauthenticated'),
    });

    await fillLogin(user, 'incorrecta');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El correo o la contraseña no son correctos');
    expect(alert).not.toHaveTextContent(/bloquead|existe|cuenta/i);
    expect(screen.getByLabelText('Correo electrónico')).toHaveValue('ana.perez@example.test');
    expect(screen.getByLabelText('Contraseña')).toHaveValue('');
  });

  it('a locked account looks exactly like a wrong password', async () => {
    const user = userEvent.setup();
    appWithSignIn('/login', {
      'POST /api/auth/login': () => problemResponse(401, 'unauthenticated'),
    });
    await fillLogin(user);
    const first = (await screen.findByRole('alert')).textContent;

    await user.type(screen.getByLabelText('Contraseña'), 'otra-vez-123456');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(first);
    });
  });

  it('tells the person to wait when the server rate limits the attempts', async () => {
    const user = userEvent.setup();
    appWithSignIn('/login', {
      'POST /api/auth/login': () => problemResponse(429, 'rate_limited'),
    });

    await fillLogin(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Hubo demasiados intentos');
  });

  it('validates the form before sending anything', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/login');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });

    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(app.requests).not.toContain('POST /api/auth/login');
  });

  it('returns to the page the person was going to', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/login?redirect=%2Fstaff');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });

    await fillLogin(user);

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/staff');
    });
  });

  it('ignores a redirect that points to another site', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/login?redirect=%2F%2Fevil.example');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });

    await fillLogin(user);

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/');
    });
  });

  it('a session that can only enroll goes straight to the security page', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/login', {
      'POST /api/auth/login': () => jsonResponse({ next: 'enrollment' }),
      'GET /api/auth/me': () =>
        jsonResponse(meFor(['professional'], { scope: 'two_factor_enrollment' })),
    });

    await fillLogin(user);

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/account/security');
    });
  });

  it('has no accessibility violations', async () => {
    const { app } = appWithSignIn('/login');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('links to password recovery', async () => {
    appWithSignIn('/login');

    expect(await screen.findByRole('link', { name: '¿Olvidó su contraseña?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});

describe('second step of the sign in', () => {
  const challenge = () => jsonResponse({ next: 'totp', challenge: 'chal-1' });

  it('asks for the code after the password and finishes the sign in with it', async () => {
    const user = userEvent.setup();
    let body = '';
    appWithSignIn('/login', {
      'POST /api/auth/login': challenge,
      'POST /api/auth/2fa': (_url, init) => {
        body = bodyText(init);
        return jsonResponse({ next: 'authenticated' });
      },
    });

    await fillLogin(user);
    expect(
      await screen.findByRole('heading', { name: 'Verificación en dos pasos' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Código de verificación'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));

    await waitFor(() => {
      expect(body).toBe('{"challenge":"chal-1","code":"123456"}');
    });
  });

  it('a wrong code shows a clear message and can be retried', async () => {
    const user = userEvent.setup();
    appWithSignIn('/login', {
      'POST /api/auth/login': challenge,
      'POST /api/auth/2fa': () => problemResponse(401, 'unauthenticated'),
    });

    await fillLogin(user);
    await user.type(await screen.findByLabelText('Código de verificación'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El código no es correcto o ya venció',
    );
    expect(screen.getByLabelText('Código de verificación')).toHaveValue('');
  });

  it('switches to a recovery code and sends it as such', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    appWithSignIn('/login', {
      'POST /api/auth/login': challenge,
      'POST /api/auth/2fa': (_url, init) => {
        sent = jsonBody(init);
        return jsonResponse({ next: 'authenticated' });
      },
    });

    await fillLogin(user);
    await user.click(await screen.findByRole('button', { name: 'Usar un código de recuperación' }));
    await user.type(screen.getByLabelText('Código de recuperación'), 'ABCD-EFGH-JKLM-NPQR');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));

    await waitFor(() => {
      expect(sent).toEqual({ challenge: 'chal-1', recoveryCode: 'ABCD-EFGH-JKLM-NPQR' });
    });
  });

  it('can go back to the first step', async () => {
    const user = userEvent.setup();
    appWithSignIn('/login', { 'POST /api/auth/login': challenge });
    await fillLogin(user);
    await screen.findByRole('heading', { name: 'Verificación en dos pasos' });

    await user.click(screen.getByRole('button', { name: 'Volver a iniciar sesión' }));

    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });
});

describe('password recovery', () => {
  it('always shows the same confirmation, whether or not the account exists', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/forgot-password', {
      'POST /api/auth/password-reset/request': () => new Response(null, { status: 204 }),
    });

    await user.type(await screen.findByLabelText('Correo electrónico'), 'nadie@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviar instrucciones' }));

    expect(await screen.findByRole('heading', { name: 'Revise su correo' })).toBeInTheDocument();
    expect(screen.getByText(/Si existe una cuenta con nadie@example.test/)).toBeInTheDocument();
    expect(app.requests).toContain('POST /api/auth/password-reset/request');
    expect(app.missingKeys).toEqual([]);
  });

  it('rejects an email without a valid shape before asking the server', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/forgot-password');

    await user.type(await screen.findByLabelText('Correo electrónico'), 'no-es-correo');
    await user.click(screen.getByRole('button', { name: 'Enviar instrucciones' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ingrese un correo electrónico válido',
    );
    expect(app.requests).not.toContain('POST /api/auth/password-reset/request');
  });

  it('sets a new password from the emailed link and then offers to sign in', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    appWithSignIn('/reset-password?token=tok-123', {
      'POST /api/auth/password-reset/complete': (_url, init) => {
        sent = jsonBody(init);
        return new Response(null, { status: 204 });
      },
    });

    await user.type(
      await screen.findByLabelText('Contraseña nueva'),
      'una frase larga y única 2026',
    );
    await user.type(screen.getByLabelText('Repetir contraseña'), 'una frase larga y única 2026');
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));

    expect(
      await screen.findByRole('heading', { name: 'Contraseña actualizada' }),
    ).toBeInTheDocument();
    expect(sent).toEqual({ token: 'tok-123', password: 'una frase larga y única 2026' });
    expect(screen.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute('href', '/login');
  });

  it('shows the password rule the server rejected next to the field and keeps the link usable', async () => {
    const user = userEvent.setup();
    appWithSignIn('/reset-password?token=tok-123', {
      'POST /api/auth/password-reset/complete': () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'x',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'r1',
            errors: [{ path: 'password', i18nKey: 'auth.password.common' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });

    await user.type(await screen.findByLabelText('Contraseña nueva'), 'contraseña123');
    await user.type(screen.getByLabelText('Repetir contraseña'), 'contraseña123');
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));

    expect(await screen.findByLabelText('Contraseña nueva')).toHaveAccessibleDescription(
      /muy común y se prueba primero/,
    );
    expect(screen.queryByText('Contraseña actualizada')).not.toBeInTheDocument();
  });

  it('does not send two passwords that differ', async () => {
    const user = userEvent.setup();
    const { app } = appWithSignIn('/reset-password?token=tok-123');

    await user.type(
      await screen.findByLabelText('Contraseña nueva'),
      'una frase larga y única 2026',
    );
    await user.type(screen.getByLabelText('Repetir contraseña'), 'otra frase distinta 2026');
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));

    expect(await screen.findByText('Las contraseñas no coinciden.')).toBeInTheDocument();
    expect(app.requests).not.toContain('POST /api/auth/password-reset/complete');
  });

  it('explains an expired or used link and offers a new one', async () => {
    const user = userEvent.setup();
    appWithSignIn('/reset-password?token=viejo', {
      'POST /api/auth/password-reset/complete': () => problemResponse(400, 'bad_request'),
    });

    await user.type(
      await screen.findByLabelText('Contraseña nueva'),
      'una frase larga y única 2026',
    );
    await user.type(screen.getByLabelText('Repetir contraseña'), 'una frase larga y única 2026');
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Este enlace venció o ya se usó');
    expect(screen.getByRole('link', { name: 'Solicitar un enlace nuevo' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('without a token in the link it says so instead of showing a form that cannot work', async () => {
    appWithSignIn('/reset-password');

    expect(await screen.findByText(/Falta el enlace de recuperación/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).not.toBeInTheDocument();
  });
});

describe('invitation', () => {
  it('activates the account with the password the person chose', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    appWithSignIn('/accept-invitation?token=inv-9', {
      'POST /api/auth/invitations/accept': (_url, init) => {
        sent = jsonBody(init);
        return new Response(null, { status: 204 });
      },
    });

    expect(await screen.findByRole('heading', { name: 'Active su cuenta' })).toBeInTheDocument();
    expect(await screen.findByText(/ingresar a Clínica Norte/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Contraseña'), 'mi frase larga de acceso 2026');
    await user.type(screen.getByLabelText('Repetir contraseña'), 'mi frase larga de acceso 2026');
    await user.click(screen.getByRole('button', { name: 'Activar cuenta' }));

    expect(
      await screen.findByRole('heading', { name: 'Su cuenta está activa' }),
    ).toBeInTheDocument();
    expect(sent).toEqual({ token: 'inv-9', password: 'mi frase larga de acceso 2026' });
  });

  it('shows the password hints before the person types', async () => {
    appWithSignIn('/accept-invitation?token=inv-9');

    expect(await screen.findByText('Una buena contraseña:')).toBeInTheDocument();
    expect(screen.getByText('Tiene entre 10 y 128 caracteres')).toBeInTheDocument();
  });

  it('explains an invitation that expired or was cancelled', async () => {
    const user = userEvent.setup();
    appWithSignIn('/accept-invitation?token=viejo', {
      'POST /api/auth/invitations/accept': () => problemResponse(400, 'bad_request'),
    });

    await user.type(await screen.findByLabelText('Contraseña'), 'mi frase larga de acceso 2026');
    await user.type(screen.getByLabelText('Repetir contraseña'), 'mi frase larga de acceso 2026');
    await user.click(screen.getByRole('button', { name: 'Activar cuenta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La invitación venció, ya se usó o fue cancelada',
    );
  });

  it('has no accessibility violations', async () => {
    const { app } = appWithSignIn('/accept-invitation?token=inv-9');
    await screen.findByRole('heading', { name: 'Active su cuenta' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
