import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

import { meOf, SELF_LINK, signedOutRoutes } from './portal-fixtures.js';

/**
 * Getting in (S5.10, task 5.39): the portal opens on a sign-in with the email of the account, or,
 * the first time, with the DNI and the email given to the consultorio. A code goes by email; the
 * answers never say whether an account exists.
 */
function open(overrides: Record<string, FetchHandler | Response> = {}) {
  const bodies: Record<string, unknown[]> = {};
  let signedIn = false;
  const record = (key: string, answer: () => Response) => (_url: string, init: RequestInit) => {
    (bodies[key] ??= []).push(jsonBody(init));
    return answer();
  };
  const app = renderApp({
    me: null,
    path: '/portal',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      ...signedOutRoutes(),
      'GET /api/portal/me': () =>
        signedIn
          ? jsonResponse(meOf([SELF_LINK], SELF_LINK.id))
          : problemResponse(401, 'unauthenticated'),
      'GET /api/portal/appointments': jsonResponse({ upcoming: [], past: [] }),
      'POST /api/public/_/portal/otp': record('otp', () => jsonResponse({ accepted: true })),
      'POST /api/public/_/portal/otp/verify': record('verify', () => {
        signedIn = true;
        return jsonResponse({ signedIn: true });
      }),
      'POST /api/public/_/portal/register': record('register', () =>
        jsonResponse({ accepted: true }),
      ),
      'POST /api/public/_/portal/register/verify': record('registerVerify', () => {
        signedIn = true;
        return jsonResponse({ signedIn: true });
      }),
      ...overrides,
    },
  });
  return { app, bodies };
}

describe('the sign-in of the portal', () => {
  it('opens on a sign-in, in the shell of the portal and without any staff navigation', async () => {
    const { app } = open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('asks for a code with the email, then signs in with the six digits', async () => {
    const user = userEvent.setup();
    const { bodies } = open();

    await user.type(await screen.findByLabelText('Correo electrónico'), '  Ana@Example.test ');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    expect(await screen.findByRole('heading', { name: 'Escriba el código' })).toBeInTheDocument();
    expect(bodies['otp']).toEqual([{ email: 'ana@example.test', challengeProof: 'not-needed' }]);
    // The page promises nothing about the account.
    expect(screen.getByText(/Si el correo tiene una cuenta/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '048213');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByText('Está viendo la información de')).toBeInTheDocument();
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
    expect(bodies['verify']).toEqual([{ email: 'ana@example.test', code: '048213' }]);
  });

  it('does not send a request for an email that is not an email, and says so', async () => {
    const user = userEvent.setup();
    const { bodies } = open();

    await user.type(await screen.findByLabelText('Correo electrónico'), 'no-es-un-correo');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Escriba un correo electrónico válido.',
    );
    expect(bodies['otp']).toBeUndefined();
  });

  it('refuses a code that is not six digits before asking the server', async () => {
    const user = userEvent.setup();
    const { bodies } = open();
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El código tiene 6 números.');
    expect(bodies['verify']).toBeUndefined();
  });

  it('shows one message for a wrong, expired or missing code, and keeps the person on the step', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/public/_/portal/otp/verify': problemResponse(400, 'portal_code_invalid') });
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '999999');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El código no es válido o ya venció. Pida uno nuevo e inténtelo otra vez.',
    );
    expect(screen.getByLabelText('Código de 6 dígitos')).toBeInTheDocument();
  });

  it('says to wait when the server stops answering for the address', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/public/_/portal/otp/verify': problemResponse(429, 'rate_limited') });
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '999999');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Hubo demasiados intentos');
  });

  it('lets the person ask for another code only after a wait, and says the newest one counts', async () => {
    const user = userEvent.setup();
    const { bodies } = open();
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    const again = await screen.findByRole('button', { name: 'Pedir otro código' });
    expect(again).toBeDisabled();
    expect(screen.getByText(/Podrá pedir otro código en \d+ segundos/)).toBeInTheDocument();
    expect(bodies['otp']).toHaveLength(1);
  });

  it('is accessible on the step of the code', async () => {
    const user = userEvent.setup();
    const { app } = open();
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.test');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));
    await screen.findByLabelText('Código de 6 dígitos');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('the first time: DNI and email', () => {
  it('asks for the DNI and the email on the record, validates the DNI and asks for the code', async () => {
    const user = userEvent.setup();
    const { bodies } = open();
    await user.click(await screen.findByRole('button', { name: 'Activar mi acceso' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Activar mi acceso' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('DNI'), '123');
    await user.type(
      screen.getByLabelText('Correo electrónico que le dio al consultorio'),
      'ana@example.test',
    );
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escriba su DNI con 7 u 8 números.');
    expect(bodies['register']).toBeUndefined();

    await user.clear(screen.getByLabelText('DNI'));
    await user.type(screen.getByLabelText('DNI'), '30.111.222');
    await user.click(screen.getByRole('button', { name: 'Enviarme un código' }));

    expect(await screen.findByRole('heading', { name: 'Escriba el código' })).toBeInTheDocument();
    expect(bodies['register']).toEqual([
      { nationalId: '30.111.222', email: 'ana@example.test', challengeProof: 'not-needed' },
    ]);
    expect(screen.getByText(/Si los datos coinciden con una ficha/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '111222');
    await user.click(screen.getByRole('button', { name: 'Activar mi acceso' }));

    expect(await screen.findByText('Está viendo la información de')).toBeInTheDocument();
    expect(bodies['registerVerify']).toEqual([
      { nationalId: '30.111.222', email: 'ana@example.test', code: '111222' },
    ]);
  });

  it('goes back to the sign-in from the registration, and back again', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Activar mi acceso' }));
    await user.click(await screen.findByRole('button', { name: 'Ingresar con mi correo' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByLabelText('DNI')).not.toBeInTheDocument();
    });
  });
});
