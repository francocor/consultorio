import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../../app/registry.js';
import { a11yViolations } from '../../../shared/test/a11y.js';
import { meFor } from '../../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';

const CHALLENGE = jsonResponse({ kind: 'fake', payload: {} });
const ACCEPTED = jsonResponse({ accepted: true });

function validationFailure(path: string, i18nKey: string) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'validation_failed',
      status: 400,
      code: 'validation_failed',
      i18nKey: 'errors.validation_failed',
      requestId: 'req-test',
      errors: [{ path, i18nKey }],
    }),
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  );
}

type Routes = Record<string, FetchHandler | Response>;

function openSignup(routes: Routes = {}) {
  const bodies: Record<string, unknown[]> = {};
  const record = (key: string, answer: () => Response) => (_url: string, init: RequestInit) => {
    (bodies[key] ??= []).push(jsonBody(init));
    return answer();
  };
  const app = renderApp({
    platform: true,
    me: null,
    path: '/signup',
    routes: {
      'GET /api/public/signup/challenge': CHALLENGE,
      'POST /api/public/signup': record('signup', () => ACCEPTED.clone()),
      'POST /api/public/signup/resend': record('resend', () => ACCEPTED.clone()),
      ...routes,
    },
  });
  return { app, bodies };
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<Record<string, string>> = {},
) {
  await user.type(
    await screen.findByLabelText('Nombre de la organización'),
    overrides['organization'] ?? 'Centro Salud Norte',
  );
  await user.type(screen.getByLabelText('Su nombre y apellido'), overrides['owner'] ?? 'Ana Pérez');
  await user.type(
    screen.getByLabelText('Correo electrónico'),
    overrides['email'] ?? 'ana@example.test',
  );
  await user.type(
    screen.getByLabelText('Contraseña'),
    overrides['password'] ?? 'una frase larga y propia',
  );
}

const accept = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('checkbox', { name: 'Acepto los términos del servicio.' }));
  await user.click(
    screen.getByRole('checkbox', { name: /Acepto los términos de tratamiento de datos/ }),
  );
};

describe('the signup page (a public page of the platform host)', () => {
  it('opens /signup on the platform host with no session and no organization, and asks for what the signup needs', async () => {
    const { app } = openSignup();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).toBeInTheDocument();
    for (const label of [
      'Nombre de la organización',
      'Su nombre y apellido',
      'Correo electrónico',
      'Contraseña',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeInTheDocument();
    // The visitor never chooses the address of the organization.
    expect(screen.queryByLabelText(/dirección|subdominio|slug/i)).not.toBeInTheDocument();
    // No organization of its own: the platform host has no boot document.
    expect(app.requests).not.toContain('GET /api/public/boot');
  });

  it('does not exist on the host of an organization, which already is one', async () => {
    renderApp({ me: null, path: '/signup' });

    // Without a session an organization's host takes a visitor to the sign-in.
    expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the operator console where it was: / on the platform host is still the console', async () => {
    renderApp({
      platform: true,
      me: null,
      path: '/',
      routes: { 'GET /api/operator/me': () => problemResponse(401, 'unauthenticated') },
    });

    expect(await screen.findByLabelText('Código de verificación')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Cree su cuenta' }),
    ).not.toBeInTheDocument();
  });

  it('registers its pages in the right mounts: the form on the platform host, the link on the organization', () => {
    const registered = defaultRegistry().routes;

    expect(registered.filter((route) => route.mount === 'platform').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(registered.filter((route) => route.mount === 'minimal').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('is served with a same-origin referrer policy, which the page with a form needs', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../../../../index.html'), 'utf8');

    expect(html).toContain('<meta name="referrer" content="same-origin"');
  });

  it('has no accessibility violations', async () => {
    const { app } = openSignup();
    await screen.findByRole('heading', { level: 1, name: 'Cree su cuenta' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('sending the form', () => {
  it('sends what the visitor typed with the proof of the challenge, and says to check the email', async () => {
    const user = userEvent.setup();
    const { app, bodies } = openSignup();
    await fill(user);
    await accept(user);

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Revise su correo' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ana@example.test/)).toBeInTheDocument();
    expect(bodies['signup']).toEqual([
      {
        organizationName: 'Centro Salud Norte',
        ownerName: 'Ana Pérez',
        email: 'ana@example.test',
        password: 'una frase larga y propia',
        acceptTerms: true,
        acceptDataProcessing: true,
        challengeProof: 'not-needed',
      },
    ]);
    // The heading takes the focus, so a screen reader announces the new screen.
    expect(screen.getByRole('heading', { level: 1, name: 'Revise su correo' })).toHaveFocus();
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('does not send until both documents are accepted, and says which one is missing', async () => {
    const user = userEvent.setup();
    const { bodies } = openSignup();
    await fill(user);
    await user.click(screen.getByRole('checkbox', { name: 'Acepto los términos del servicio.' }));

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    const alerts = await screen.findAllByText('Para crear la cuenta debe aceptar este punto.');
    expect(alerts).toHaveLength(1);
    expect(bodies['signup']).toBeUndefined();
  });

  it('asks for the required fields before sending anything', async () => {
    const user = userEvent.setup();
    const { bodies } = openSignup();
    await screen.findByLabelText('Nombre de la organización');

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect((await screen.findAllByRole('alert')).length).toBeGreaterThanOrEqual(5);
    expect(bodies['signup']).toBeUndefined();
  });

  it('puts the rejection of the password under its field and keeps what was typed', async () => {
    const user = userEvent.setup();
    const { bodies } = openSignup({
      'POST /api/public/signup': () => validationFailure('password', 'auth.password.common'),
    });
    await fill(user, { password: 'password1234' });
    await accept(user);

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(await screen.findByText(/Esa contraseña es muy común/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de la organización')).toHaveValue('Centro Salud Norte');
    expect(screen.queryByRole('heading', { name: 'Revise su correo' })).not.toBeInTheDocument();
    expect(bodies['signup']).toBeUndefined();
  });

  it('says it plainly when it must wait, or when the challenge failed', async () => {
    const user = userEvent.setup();
    openSignup({ 'POST /api/public/signup': () => problemResponse(429, 'rate_limited') });
    await fill(user);
    await accept(user);

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/demasiad/i);
  });

  it('shows the same screen whatever the API knew about the address (it never says)', async () => {
    const user = userEvent.setup();
    openSignup();
    await fill(user, { email: 'ya-existe@example.test' });
    await accept(user);

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Revise su correo' });
    expect(heading).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ya existe|ya tiene una cuenta con/i);
  });
});

describe('asking for the email again', () => {
  async function toTheCheckScreen(user: ReturnType<typeof userEvent.setup>, routes: Routes = {}) {
    const opened = openSignup(routes);
    await fill(user);
    await accept(user);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    await screen.findByRole('heading', { level: 1, name: 'Revise su correo' });
    return opened;
  }

  it('sends the address again with a new proof and tells the old link stopped working', async () => {
    const user = userEvent.setup();
    const { bodies } = await toTheCheckScreen(user);

    await user.click(screen.getByRole('button', { name: 'Enviar el correo de nuevo' }));

    expect(await screen.findByText(/enviamos un correo nuevo/)).toBeInTheDocument();
    expect(bodies['resend']).toEqual([{ email: 'ana@example.test', challengeProof: 'not-needed' }]);
  });

  it('tells the visitor when it has to wait before asking again', async () => {
    const user = userEvent.setup();
    await toTheCheckScreen(user, {
      'POST /api/public/signup/resend': () => problemResponse(429, 'rate_limited'),
    });

    await user.click(screen.getByRole('button', { name: 'Enviar el correo de nuevo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/demasiad/i);
  });

  it('goes back to the form to use another address', async () => {
    const user = userEvent.setup();
    await toTheCheckScreen(user);

    await user.click(screen.getByRole('button', { name: 'Usar otro correo' }));

    expect(await screen.findByLabelText('Correo electrónico')).toHaveValue('ana@example.test');
  });
});

describe('the page of the emailed link (the host of the organization)', () => {
  function openLink(
    path: string,
    routes: Routes = {},
  ): { app: RenderedApp; bodies: Record<string, unknown[]> } {
    const bodies: Record<string, unknown[]> = {};
    const record = (key: string, answer: () => Response) => (_url: string, init: RequestInit) => {
      (bodies[key] ??= []).push(jsonBody(init));
      return answer();
    };
    const app = renderApp({
      me: null,
      path,
      routes: {
        'GET /api/public/signup/challenge': CHALLENGE,
        'POST /api/public/signup/verify': record('verify', () => jsonResponse({ verified: true })),
        'POST /api/public/signup/renew': record('renew', () => ACCEPTED.clone()),
        'GET /api/auth/me': jsonResponse(meFor(['owner'], { needsWizard: true })),
        ...routes,
      },
    });
    return { app, bodies };
  }

  it('shows what the link is for and spends nothing until the button is pressed', async () => {
    const { app, bodies } = openLink('/signup/verify?token=abcdefghij');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Active su organización' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/para activar Clínica Norte/)).toBeInTheDocument();
    expect(bodies['verify']).toBeUndefined();
    expect(app.requests).not.toContain('POST /api/public/signup/verify');
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('activates with the token of the link and takes the owner to the setup wizard', async () => {
    const user = userEvent.setup();
    const { app, bodies } = openLink('/signup/verify?token=abcdefghij');

    await user.click(await screen.findByRole('button', { name: 'Activar mi organización' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/onboarding');
    });
    expect(bodies['verify']).toEqual([{ token: 'abcdefghij' }]);
  });

  it('says there is no link when the address has none', async () => {
    openLink('/signup/verify');

    expect(await screen.findByText(/Falta el enlace de activación/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Activar mi organización' }),
    ).not.toBeInTheDocument();
  });

  it('offers a new link when this one does not work, and says to check the email when it is sent', async () => {
    const user = userEvent.setup();
    const { bodies } = openLink('/signup/verify?token=vencido', {
      'POST /api/public/signup/verify': () => problemResponse(400, 'signup_link_invalid'),
    });

    await user.click(await screen.findByRole('button', { name: 'Activar mi organización' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/no es válido o ya venció/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pedir un enlace nuevo' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Revise su correo' }),
    ).toBeInTheDocument();
    expect(bodies['renew']).toEqual([{ challengeProof: 'not-needed' }]);
  });

  it('does not call a link invalid when the server failed: the link was not spent and the button stays', async () => {
    const user = userEvent.setup();
    openLink('/signup/verify?token=abcdefghij', {
      'POST /api/public/signup/verify': () => problemResponse(500, 'internal_error'),
    });

    await user.click(await screen.findByRole('button', { name: 'Activar mi organización' }));

    expect(await screen.findByRole('alert')).not.toHaveTextContent(/no es válido|venció/);
    expect(screen.getByRole('button', { name: 'Activar mi organización' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir un enlace nuevo' })).not.toBeInTheDocument();
  });

  it('keeps the offer when the new link cannot be asked for right now', async () => {
    const user = userEvent.setup();
    openLink('/signup/verify?token=vencido', {
      'POST /api/public/signup/verify': () => problemResponse(400, 'signup_link_invalid'),
      'POST /api/public/signup/renew': () => problemResponse(429, 'rate_limited'),
    });

    await user.click(await screen.findByRole('button', { name: 'Activar mi organización' }));
    await user.click(await screen.findByRole('button', { name: 'Pedir un enlace nuevo' }));

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Pedir un enlace nuevo' })).toBeInTheDocument();
  });
});
