import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../shared/test/render.js';

import { CHECKLIST_LINKS } from './checklist-links.js';
import { stateFor, type StateOptions } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;

function open({
  state,
  me = meFor(['owner']),
  path = '/',
  routes,
}: {
  state?: StateOptions | null;
  me?: ReturnType<typeof meFor>;
  path?: string;
  routes?: Record<string, Handler>;
} = {}) {
  return renderApp({
    me,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      ...(state === null
        ? {}
        : { 'GET /api/onboarding/state': () => jsonResponse(stateFor(state)) }),
      ...routes,
    },
  });
}

const card = () => screen.findByRole('region', { name: 'Primeros pasos' });

describe('the first-run checklist on the start page', () => {
  it('shows the owner what is left, how far along they are, and a way back into the wizard', async () => {
    const app = open({ state: { done: ['location', 'appointment_type'], currentStep: 'hours' } });

    const region = await card();
    expect(within(region).getByText('2 de 8 listos')).toBeInTheDocument();
    expect(
      within(region).getByRole('link', { name: 'Continuar la configuración' }),
    ).toHaveAttribute('href', '/onboarding');
    const list = within(region).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(await a11yViolations(document.body)).toEqual([]);
    expect(app.missingKeys).toEqual([]);
  });

  it('marks an item done with words, not only color, and every pending item links to its screen', async () => {
    open({ state: { done: ['location'] } });

    const region = await card();
    const done = within(region)
      .getByText('Crear un consultorio o sede')
      .closest('li') as HTMLElement;
    expect(within(done).getByText('Hecho')).toBeInTheDocument();
    const pending = within(region)
      .getByText('Registrar el primer paciente')
      .closest('li') as HTMLElement;
    expect(within(pending).getByText('Pendiente')).toBeInTheDocument();
    expect(
      within(pending).getByRole('link', { name: /Registrar el primer paciente/ }),
    ).toHaveAttribute('href', '/patients/new');
    expect(within(region).getByRole('link', { name: /Dar el primer turno/ })).toHaveAttribute(
      'href',
      '/calendar',
    );
    expect(
      within(region).getByRole('link', { name: /Cargar la matrícula profesional/ }),
    ).toHaveAttribute('href', '/onboarding?step=profile');
    expect(within(region).getByRole('link', { name: /Invitar a su equipo/ })).toHaveAttribute(
      'href',
      '/onboarding?step=team',
    );
  });

  it('has a link for every item of the checklist', () => {
    expect(Object.keys(CHECKLIST_LINKS).toSorted()).toEqual(
      [
        'location',
        'hours',
        'appointment_type',
        'first_patient',
        'first_appointment',
        'matricula',
        'invite_staff',
        'branding',
      ].toSorted(),
    );
  });

  it('hides when the owner dismisses it, and says where to find it again', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      state: {},
      routes: {
        'PUT /api/onboarding/state': (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(stateFor({ dismissed: true }));
        },
      },
    });

    await card();
    await user.click(screen.getByRole('button', { name: 'Ocultar' }));

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    });
    expect(body).toEqual({ checklistDismissed: true });
  });

  it('stays away once dismissed and once everything is done', async () => {
    const dismissed = open({ state: { dismissed: true } });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    dismissed.unmount();

    open({
      state: {
        completed: true,
        done: [
          'location',
          'hours',
          'appointment_type',
          'first_patient',
          'first_appointment',
          'matricula',
          'invite_staff',
          'branding',
        ],
      },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
  });

  it('is not shown to reception, and nothing is requested for them', async () => {
    const app = open({ me: meFor(['reception']), state: null });

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    expect(app.requests.filter((request) => request.includes('/api/onboarding'))).toEqual([]);
  });

  it('is not shown to an admin until the owner grants the permission', async () => {
    const withoutGrant = open({ me: meFor(['admin']), state: null });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    withoutGrant.unmount();

    open({ me: meFor(['admin'], { grants: ['onboarding.manage'] }), state: {} });
    expect(await card()).toBeInTheDocument();
  });

  it('keeps quiet when the progress cannot be loaded: a failed card must not block the page', async () => {
    open({ state: null });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
  });
});

describe('Help: the checklist stays reachable', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Menú de la cuenta' }));
  }

  it('opens from the account menu with the current progress, even after dismissing it', async () => {
    const user = userEvent.setup();
    const app = open({
      state: { dismissed: true, done: ['location', 'hours', 'appointment_type'] },
    });

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Primeros pasos' }));

    const dialog = await screen.findByRole('dialog', { name: 'Primeros pasos' });
    expect(within(dialog).getByText('3 de 8 listos')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('link', { name: /Registrar el primer paciente/ }),
    ).toHaveAttribute('href', '/patients/new');
    expect(await a11yViolations(dialog)).toEqual([]);
    expect(app.missingKeys).toEqual([]);
  });

  it('lets the owner bring the checklist back to the start page', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      state: { dismissed: true },
      routes: {
        'PUT /api/onboarding/state': (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(stateFor({ dismissed: false }));
        },
      },
    });

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Primeros pasos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Primeros pasos' });
    await user.click(within(dialog).getByRole('button', { name: 'Mostrar en el inicio' }));

    await waitFor(() => {
      expect(body).toEqual({ checklistDismissed: false });
    });
  });

  it('is not in the menu of reception', async () => {
    const user = userEvent.setup();
    open({ me: meFor(['reception']), state: null });

    await openMenu(user);

    expect(await screen.findByRole('menuitem', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Primeros pasos' })).not.toBeInTheDocument();
  });
});

describe('signing in', () => {
  it('takes an owner who still has to run the wizard straight into it', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['owner'], { needsWizard: true }),
      path: '/login',
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        'POST /api/auth/login': () => jsonResponse({ next: 'authenticated' }),
        'GET /api/onboarding/state': () => jsonResponse(stateFor()),
      },
    });

    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana.perez@example.test');
    await user.type(screen.getByLabelText('Contraseña'), 'una frase larga para entrar');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/onboarding');
    });
  });

  it('goes to the page that was asked for, even if the wizard is pending', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['owner'], { needsWizard: true }),
      path: '/login?redirect=%2Fpatients',
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        'POST /api/auth/login': () => jsonResponse({ next: 'authenticated' }),
        'GET /api/onboarding/state': () => jsonResponse(stateFor()),
        'GET /api/patients': () => jsonResponse({ patients: [], nextCursor: null }),
      },
    });

    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana.perez@example.test');
    await user.type(screen.getByLabelText('Contraseña'), 'una frase larga para entrar');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/patients');
    });
  });

  it('goes to the start page when there is nothing left to set up', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      me: meFor(['reception']),
      path: '/login',
      boot: bootFor('Centro Médico Aillu'),
      routes: { 'POST /api/auth/login': () => jsonResponse({ next: 'authenticated' }) },
    });

    await user.type(await screen.findByLabelText('Correo electrónico'), 'recepcion@example.test');
    await user.type(screen.getByLabelText('Contraseña'), 'una frase larga para entrar');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/');
    });
  });
});
