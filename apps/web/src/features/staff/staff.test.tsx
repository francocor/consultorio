import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { bodyText, jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { DEACTIVATED, IDS, LOCATIONS, MEMBERS } from './fixtures.js';

type Handler = (url: string, init: RequestInit) => Response;

function open(
  routes: Record<string, Handler> = {},
  me = meFor(['owner'], { user: { id: IDS.owner, email: 'propietaria@demo.invalid' } }),
) {
  return renderApp({
    me,
    path: '/staff',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/staff': (url) =>
        jsonResponse({
          staff: url.includes('includeDeactivated=true') ? [...MEMBERS, DEACTIVATED] : MEMBERS,
        }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      ...routes,
    },
  });
}

async function manage(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Gestionar a ${name}` }));
  return screen.findByRole('dialog');
}

describe('staff directory', () => {
  it('lists the people with role, locations, discipline and the state of the matricula', async () => {
    const app = open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Equipo' })).toBeInTheDocument();
    expect(await screen.findByText('3 personas')).toBeInTheDocument();
    const doctor = screen.getByText('Dra. Lucía Paz Ferrer').closest('li');
    expect(doctor).not.toBeNull();
    const card = within(doctor as HTMLElement);
    expect(card.getByText('Profesional')).toBeInTheDocument();
    expect(card.getByText('Cardiología')).toBeInTheDocument();
    expect(card.getByText('Sede Central')).toBeInTheDocument();
    expect(card.getByText('Consultorios Norte')).toBeInTheDocument();
    expect(card.getByText('Matrícula AR-C 41258')).toBeInTheDocument();
    expect(card.getByText('Sin verificar')).toBeInTheDocument();
    expect(card.getByText('cardiologia@demo.invalid')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('marks the signed-in person', async () => {
    open();

    const own = (await screen.findByText('Marcela Quiroga')).closest('li');
    expect(within(own as HTMLElement).getByText('Usted')).toBeInTheDocument();
  });

  it('can include deactivated people, who are shown as such', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText('3 personas');

    await user.click(screen.getByRole('switch', { name: 'Mostrar personas desactivadas' }));

    const former = (await screen.findByText('Julián Acosta')).closest('li');
    expect(within(former as HTMLElement).getByText('Desactivado')).toBeInTheDocument();
    expect(await screen.findByText('4 personas')).toBeInTheDocument();
  });

  it('has an empty state with the invitation as the first action', async () => {
    open({ 'GET /api/staff': () => jsonResponse({ staff: [] }) });

    expect(
      await screen.findByRole('heading', { name: 'Todavía no hay nadie en el equipo' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invitar a una persona' }).length).toBeGreaterThan(
      0,
    );
  });

  it('shows a retryable error when the directory cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    open({
      'GET /api/staff': () =>
        fail ? problemResponse(500, 'internal_error') : jsonResponse({ staff: MEMBERS }),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Código de referencia');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('3 personas')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByText('3 personas');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('inviting a person', () => {
  it('sends the invitation with the chosen roles and says when it expires', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const app = open({
      'POST /api/staff/invitations': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ expiresAt: '2026-10-23T12:00:00.000Z' }, 201);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invitar a una persona' });

    await user.type(within(dialog).getByLabelText('Correo electrónico'), 'nueva@example.test');
    await user.type(within(dialog).getByLabelText('Nombre para mostrar'), 'Nora Gil');
    await user.click(within(dialog).getByRole('checkbox', { name: /Recepción/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar invitación' }));

    await waitFor(() => {
      expect(body).toEqual({
        email: 'nueva@example.test',
        roles: ['reception'],
        displayName: 'Nora Gil',
      });
    });
    expect(
      await screen.findByText(/Invitación enviada a nueva@example\.test\. Vence el 23\/10\/2026/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(app.missingKeys).toEqual([]);
  });

  it('an owner may invite any role; an administrator may not invite an owner', async () => {
    const user = userEvent.setup();
    open({}, meFor(['admin'], { user: { id: IDS.owner, email: 'administracion@demo.invalid' } }));
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('checkbox', { name: /Administración/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Profesional/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Recepción/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Propietario/ })).not.toBeInTheDocument();
  });

  it('shows the validation next to the field and sends nothing', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Correo electrónico'), 'no-es-correo');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar invitación' }));

    expect(
      await within(dialog).findByText('Ingrese un correo electrónico válido.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Elija al menos un rol.')).toBeInTheDocument();
    expect(app.requests).not.toContain('POST /api/staff/invitations');
  });

  it('explains when the person already belongs to the team', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/staff/invitations': () => problemResponse(409, 'conflict') });
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Correo electrónico'), 'ya@example.test');
    await user.click(within(dialog).getByRole('checkbox', { name: /Recepción/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar invitación' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ya forma parte del equipo');
  });

  it('the dialog has no accessibility violations', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Invitar a una persona' }));
    const dialog = await screen.findByRole('dialog');

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

describe('managing a person', () => {
  it('changes the roles within what the signed-in person may grant', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`PUT /api/members/${IDS.reception}/roles`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ membershipId: IDS.reception, roles: ['reception', 'professional'] });
      },
    });
    const sheet = await manage(user, 'Camila Duarte');

    await user.click(within(sheet).getByRole('checkbox', { name: /Profesional/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Guardar roles' }));

    await waitFor(() => {
      expect(body).toEqual({ roles: ['professional', 'reception'] });
    });
    expect(await screen.findByText('Roles actualizados.')).toBeInTheDocument();
  });

  it('deactivates a person after confirming, and reactivates them', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      [`POST /api/staff/${IDS.reception}/deactivate`]: () => {
        calls.push('deactivate');
        return jsonResponse({ membershipId: IDS.reception, status: 'deactivated' });
      },
    });
    const sheet = await manage(user, 'Camila Duarte');

    await user.click(within(sheet).getByRole('button', { name: 'Desactivar a esta persona' }));
    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Desactivar a Camila Duarte?',
    });
    expect(confirmation).toHaveTextContent('Su historial se conserva');
    await user.click(within(confirmation).getByRole('button', { name: 'Desactivar' }));

    await waitFor(() => {
      expect(calls).toEqual(['deactivate']);
    });
    expect(await screen.findByText('Persona desactivada.')).toBeInTheDocument();
  });

  it('offers to reactivate someone who is deactivated', async () => {
    const user = userEvent.setup();
    let reactivated = false;
    open({
      [`POST /api/staff/${IDS.deactivated}/reactivate`]: () => {
        reactivated = true;
        return jsonResponse({ membershipId: IDS.deactivated, status: 'active' });
      },
    });
    await screen.findByText('3 personas');
    await user.click(screen.getByRole('switch', { name: 'Mostrar personas desactivadas' }));
    const sheet = await manage(user, 'Julián Acosta');

    expect(
      within(sheet).queryByRole('button', { name: 'Desactivar a esta persona' }),
    ).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Reactivar a esta persona' }));

    await waitFor(() => {
      expect(reactivated).toBe(true);
    });
  });

  it('assigns locations to a person', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/members/${IDS.reception}/locations`]: () =>
        jsonResponse({ membershipId: IDS.reception, locationIds: [] }),
      [`PUT /api/members/${IDS.reception}/locations`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ membershipId: IDS.reception, locationIds: [IDS.norte] });
      },
    });
    const sheet = await manage(user, 'Camila Duarte');
    await user.click(within(sheet).getByRole('tab', { name: 'Sedes y horarios' }));

    await user.click(await within(sheet).findByRole('checkbox', { name: 'Consultorios Norte' }));
    await user.click(within(sheet).getByRole('button', { name: 'Guardar sedes' }));

    await waitFor(() => {
      expect(body).toEqual({ locationIds: [IDS.norte] });
    });
    expect(await screen.findByText('Sedes actualizadas.')).toBeInTheDocument();
  });
});

describe('professional profile', () => {
  const profile = {
    id: IDS.professionalProfile,
    membershipId: IDS.professional,
    fullName: 'Lucía Paz Ferrer',
    status: 'active',
    specialties: ['Cardiología'],
    matricula: { jurisdiction: 'AR-C', number: '41258', status: 'unverified' },
    maxSimultaneous: 1,
    clinicalAccess: true,
  };

  it('shows the profile with the matricula marked as unverified', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/staff/${IDS.professional}/professional-profile`]: () => jsonResponse(profile),
    });
    const sheet = await manage(user, 'Dra. Lucía Paz Ferrer');
    await user.click(within(sheet).getByRole('tab', { name: 'Perfil profesional' }));

    expect(await within(sheet).findByLabelText('Nombre completo')).toHaveValue('Lucía Paz Ferrer');
    expect(within(sheet).getByLabelText('Número de matrícula')).toHaveValue('41258');
    expect(within(sheet).getByLabelText('Jurisdicción de la matrícula')).toHaveValue('AR-C');
    expect(within(sheet).getByText('Sin verificar')).toBeInTheDocument();
    expect(within(sheet).getByText('Cardiología')).toBeInTheDocument();
  });

  it('saves several specialties and a new matricula', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/staff/${IDS.professional}/professional-profile`]: () => jsonResponse(profile),
      [`PUT /api/staff/${IDS.professional}/professional-profile`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ ...profile, specialties: ['Cardiología', 'Clínica médica'] });
      },
    });
    const sheet = await manage(user, 'Dra. Lucía Paz Ferrer');
    await user.click(within(sheet).getByRole('tab', { name: 'Perfil profesional' }));
    await within(sheet).findByLabelText('Nombre completo');

    await user.type(within(sheet).getByLabelText('Nueva especialidad'), 'Clínica médica');
    await user.click(within(sheet).getByRole('button', { name: 'Agregar' }));
    await user.clear(within(sheet).getByLabelText('Número de matrícula'));
    await user.type(within(sheet).getByLabelText('Número de matrícula'), '50210');
    await user.click(within(sheet).getByRole('button', { name: 'Guardar perfil' }));

    await waitFor(() => {
      expect(body).toEqual({
        fullName: 'Lucía Paz Ferrer',
        specialties: ['Cardiología', 'Clínica médica'],
        matricula: { jurisdiction: 'AR-C', number: '50210' },
        maxSimultaneous: 1,
      });
    });
    expect(await screen.findByText('Perfil profesional guardado.')).toBeInTheDocument();
  });

  it('removes a specialty, and does not let the profile be saved without any', async () => {
    const user = userEvent.setup();
    const app = open({
      [`GET /api/staff/${IDS.professional}/professional-profile`]: () => jsonResponse(profile),
    });
    const sheet = await manage(user, 'Dra. Lucía Paz Ferrer');
    await user.click(within(sheet).getByRole('tab', { name: 'Perfil profesional' }));
    await within(sheet).findByLabelText('Nombre completo');

    await user.click(within(sheet).getByRole('button', { name: 'Quitar Cardiología' }));
    await user.click(within(sheet).getByRole('button', { name: 'Guardar perfil' }));

    expect(await within(sheet).findByText('Cargue al menos una especialidad.')).toBeInTheDocument();
    expect(app.requests.filter((request) => request.startsWith('PUT'))).toEqual([]);
  });

  it('shows the matricula error of the country next to the field', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/staff/${IDS.professional}/professional-profile`]: () => jsonResponse(profile),
      [`PUT /api/staff/${IDS.professional}/professional-profile`]: () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'x',
            status: 400,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'r1',
            errors: [{ path: 'matricula', i18nKey: 'country.ar.matricula.invalid' }],
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    const sheet = await manage(user, 'Dra. Lucía Paz Ferrer');
    await user.click(within(sheet).getByRole('tab', { name: 'Perfil profesional' }));
    await within(sheet).findByLabelText('Nombre completo');

    await user.click(within(sheet).getByRole('button', { name: 'Guardar perfil' }));

    expect(
      await within(sheet).findByText('El número de matrícula no tiene un formato válido.'),
    ).toBeInTheDocument();
  });

  it('says so when the person is not a professional', async () => {
    const user = userEvent.setup();
    open();
    const sheet = await manage(user, 'Camila Duarte');
    await user.click(within(sheet).getByRole('tab', { name: 'Perfil profesional' }));

    expect(await within(sheet).findByText(/no tiene el rol de profesional/)).toBeInTheDocument();
  });
});

describe('extra permissions', () => {
  const grantable = [
    'scheduling.override_hours',
    'scheduling.register_past',
    'scheduling.delegated_calendar',
    'cash.operate',
    'patients.administer',
  ];

  it('offers exactly the grantable permissions, never a clinical one', async () => {
    const user = userEvent.setup();
    open({
      [`GET /api/members/${IDS.reception}/grants`]: () => jsonResponse({ grantable, grants: [] }),
    });
    const sheet = await manage(user, 'Camila Duarte');
    await user.click(within(sheet).getByRole('tab', { name: 'Permisos' }));

    const switches = await within(sheet).findAllByRole('switch');
    expect(switches).toHaveLength(5);
    expect(within(sheet).getByRole('switch', { name: /Operar la caja/ })).not.toBeChecked();
    expect(sheet).not.toHaveTextContent(/historia clínica|nota clínica/i);
  });

  it('grants and revokes a permission', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let granted = false;
    open({
      [`GET /api/members/${IDS.reception}/grants`]: () =>
        jsonResponse({
          grantable,
          grants: granted
            ? [
                {
                  id: '0190a000-0000-7000-8000-0000000000d1',
                  permission: 'cash.operate',
                  scope: {},
                  grantedBy: IDS.owner,
                  grantedAt: '2026-10-16T10:00:00.000Z',
                },
              ]
            : [],
        }),
      [`POST /api/members/${IDS.reception}/grants`]: (_url, init) => {
        calls.push(`grant ${bodyText(init)}`);
        granted = true;
        return new Response(null, { status: 204 });
      },
      [`DELETE /api/members/${IDS.reception}/grants/cash.operate`]: () => {
        calls.push('revoke');
        granted = false;
        return new Response(null, { status: 204 });
      },
    });
    const sheet = await manage(user, 'Camila Duarte');
    await user.click(within(sheet).getByRole('tab', { name: 'Permisos' }));

    await user.click(await within(sheet).findByRole('switch', { name: /Operar la caja/ }));
    await waitFor(() => {
      expect(within(sheet).getByRole('switch', { name: /Operar la caja/ })).toBeChecked();
    });
    await user.click(within(sheet).getByRole('switch', { name: /Operar la caja/ }));

    await waitFor(() => {
      expect(calls).toEqual(['grant {"permission":"cash.operate"}', 'revoke']);
    });
  });

  it('asks which professionals a delegated calendar covers', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`GET /api/members/${IDS.reception}/grants`]: () => jsonResponse({ grantable, grants: [] }),
      [`POST /api/members/${IDS.reception}/grants`]: (_url, init) => {
        body = jsonBody(init);
        return new Response(null, { status: 204 });
      },
    });
    const sheet = await manage(user, 'Camila Duarte');
    await user.click(within(sheet).getByRole('tab', { name: 'Permisos' }));

    await user.click(await within(sheet).findByRole('switch', { name: /Manejar la agenda/ }));
    const picker = await screen.findByRole('dialog', { name: 'Elija qué agendas podrá manejar' });
    await user.click(within(picker).getByRole('checkbox', { name: 'Dra. Lucía Paz Ferrer' }));
    await user.click(within(picker).getByRole('button', { name: 'Otorgar permiso' }));

    await waitFor(() => {
      expect(body).toEqual({
        permission: 'scheduling.delegated_calendar',
        scope: { professionalIds: [IDS.professionalProfile] },
      });
    });
  });
});
