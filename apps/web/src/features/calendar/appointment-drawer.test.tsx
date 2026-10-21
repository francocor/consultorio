import { effectivePermissions, type AppointmentStatus, type Role } from '@consultorio/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createRegistry, defaultRegistry, type AppRegistry } from '../../app/registry.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { meFor } from '../../shared/test/fixtures.js';
import { renderInRouter } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import { AppointmentDrawer } from './components/AppointmentDrawer.js';
import type { SchedulingProfessional } from './containers/use-scheduling-people.js';
import { entry, IDS, LOCATIONS, TYPES } from './fixtures.js';

// 2026-10-17 15:00 UTC is 12:00 in Buenos Aires: the fixture appointment (10:00) already started.
const NOW = new Date('2026-10-17T15:00:00Z');
const FUTURE_START = '2026-10-17T18:00:00.000Z';
const ID = IDS.appointmentGomez;

const ANA: SchedulingProfessional = {
  id: IDS.ana,
  membershipId: IDS.anaMembership,
  name: 'Dra. Ana Pérez',
  specialties: ['Cardiología'],
  locationIds: [IDS.central],
};
const BETO: SchedulingProfessional = {
  id: IDS.beto,
  membershipId: IDS.betoMembership,
  name: 'Dr. Beto Ruiz',
  specialties: ['Pediatría'],
  locationIds: [IDS.central],
};

const HISTORY = {
  appointmentId: ID,
  rescheduledCount: 1,
  events: [
    {
      id: '0190a000-0000-7000-8000-0000000000a1',
      kind: 'created',
      fromStatus: null,
      toStatus: 'scheduled',
      actorUserId: IDS.receptionMembership,
      actorKind: 'staff',
      at: '2026-10-10T15:00:00.000Z',
      details: {},
    },
    {
      id: '0190a000-0000-7000-8000-0000000000a2',
      kind: 'rescheduled',
      fromStatus: null,
      toStatus: null,
      actorUserId: IDS.receptionMembership,
      actorKind: 'staff',
      at: '2026-10-12T15:30:00.000Z',
      details: {},
    },
    {
      id: '0190a000-0000-7000-8000-0000000000a3',
      kind: 'status_changed',
      fromStatus: 'scheduled',
      toStatus: 'confirmed',
      actorUserId: null,
      actorKind: 'patient',
      at: '2026-10-15T13:00:00.000Z',
      details: {},
    },
  ],
};

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'req-9',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** What the API answers with: the appointment, without the names the feed adds. */
function appointmentOf(overrides: Record<string, unknown>) {
  const names = new Set(['patientName', 'typeName', 'typeColor', 'mode']);
  const base = Object.fromEntries(Object.entries(entry()).filter(([key]) => !names.has(key)));
  return { ...base, ...overrides };
}

interface Mount {
  status?: AppointmentStatus;
  startsAt?: string;
  roles?: Role[];
  grants?: string[];
  ownProfessionalId?: string | null;
  readOnly?: boolean;
  identityConfirmed?: boolean;
  routes?: Record<string, FetchHandler | Response>;
  registry?: AppRegistry;
}

// The drawer sits inside the signed-in frame, which waits for the slots of the features before it draws.
// This test mounts it alone, so it waits for them here.
beforeAll(async () => {
  await defaultRegistry().ready();
});

function mount(options: Mount = {}) {
  const status = options.status ?? 'scheduled';
  const startsAt = options.startsAt ?? FUTURE_START;
  const current = entry({
    status,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
    identityConfirmed: options.identityConfirmed ?? true,
    version: 3,
  });
  const roles = options.roles ?? ['reception'];
  const onClose = vi.fn();
  const posts: { path: string; body: unknown }[] = [];
  const record =
    (path: string, response: () => Response): FetchHandler =>
    (_url, init) => {
      posts.push({ path, body: jsonBody(init) });
      return response();
    };
  const app = renderInRouter(
    <AppointmentDrawer
      appointmentId={ID}
      onClose={onClose}
      locations={LOCATIONS}
      professionals={[ANA, BETO]}
      ownProfessionalId={options.ownProfessionalId ?? null}
      permissions={effectivePermissions(roles, options.grants ?? [])}
      readOnly={options.readOnly ?? false}
      now={NOW}
    />,
    {
      me: meFor(roles),
      ...(options.registry ? { registry: options.registry } : {}),
      routes: {
        [`GET /api/appointments/${ID}`]: () => jsonResponse(current),
        [`GET /api/appointments/${ID}/history`]: () => jsonResponse(HISTORY),
        'GET /api/appointment-types': () => jsonResponse({ types: TYPES }),
        'GET /api/availability': () =>
          jsonResponse({
            professionalId: IDS.ana,
            typeId: IDS.control,
            slots: [
              {
                startsAt: '2026-10-18T13:00:00.000Z',
                endsAt: '2026-10-18T13:30:00.000Z',
                locationId: IDS.central,
                date: '2026-10-18',
              },
              {
                startsAt: '2026-10-18T13:30:00.000Z',
                endsAt: '2026-10-18T14:00:00.000Z',
                locationId: IDS.central,
                date: '2026-10-18',
              },
            ],
            closedDays: [],
          }),
        ...Object.fromEntries(
          ['confirm', 'start', 'attend', 'no-show', 'approve', 'check-in'].map((action) => [
            `POST /api/appointments/${ID}/${action}`,
            record(action, () => jsonResponse(appointmentOf({ version: 4 }))),
          ]),
        ),
        ...options.routes,
      },
    },
  );
  return { ...app, onClose, posts, record };
}

const buttonNames = () => screen.getAllByRole('button').map((button) => button.textContent);

async function opened(options: Mount = {}) {
  const app = mount(options);
  await screen.findByRole('dialog');
  await screen.findByText('Gómez, Valentina');
  return app;
}

describe('what the drawer shows', () => {
  it('says who, when, with whom and in which state, in words', async () => {
    const app = await opened({ status: 'confirmed' });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Gómez, Valentina')).toBeInTheDocument();
    expect(within(dialog).getByText('Confirmado')).toBeInTheDocument();
    expect(within(dialog).getByText('Control')).toBeInTheDocument();
    expect(within(dialog).getByText('Dra. Ana Pérez')).toBeInTheDocument();
    expect(within(dialog).getByText('Sede Central')).toBeInTheDocument();
    // 18:00 UTC is 15:00 in Buenos Aires, the zone of the location.
    expect(within(dialog).getByText(/15:00 a 15:30/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('warns in words when the identity of the patient is not confirmed', async () => {
    await opened({ identityConfirmed: false });

    expect(
      screen.getByText('La identidad del paciente todavía no fue confirmada.'),
    ).toBeInTheDocument();
  });

  it('links to the record of the patient', async () => {
    await opened();

    expect(screen.getByRole('link', { name: 'Ver ficha del paciente' })).toHaveAttribute(
      'href',
      `/patients/${IDS.patientGomez}`,
    );
  });

  it('lists the history with who did what, and how many times it was moved', async () => {
    await opened();

    const history = await screen.findByRole('list', { name: 'Historial del turno' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Turno asignado');
    expect(items[1]).toHaveTextContent('Turno reprogramado');
    expect(items[2]).toHaveTextContent('Pasó de Programado a Confirmado');
    expect(items[2]).toHaveTextContent('Paciente');
    expect(screen.getByText('Reprogramado 1 vez')).toBeInTheDocument();
  });
});

describe('only the actions that can succeed are offered', () => {
  it.each<[AppointmentStatus, string[]]>([
    ['pending_approval', ['Aprobar turno', 'Cancelar turno', 'Reprogramar']],
    ['scheduled', ['Confirmar turno', 'Registrar llegada', 'Cancelar turno', 'Reprogramar']],
    ['confirmed', ['Registrar llegada', 'Cancelar turno', 'Reprogramar']],
    ['checked_in', ['Iniciar consulta', 'Cancelar turno']],
    ['in_progress', ['Finalizar consulta']],
    ['attended', ['Corregir estado']],
    ['no_show', ['Corregir estado']],
    ['cancelled', ['Corregir estado']],
  ])('%s', async (status, expected) => {
    await opened({ status });

    const dialog = screen.getByRole('dialog');
    const offered = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text) =>
        [
          'Aprobar turno',
          'Confirmar turno',
          'Registrar llegada',
          'Iniciar consulta',
          'Finalizar consulta',
          'Marcar como ausente',
          'Cancelar turno',
          'Reprogramar',
          'Corregir estado',
        ].includes(text),
      );
    expect(offered).toEqual(expected);
  });

  it('offers the absence only once the appointment was due to start', async () => {
    await opened({ status: 'scheduled', startsAt: '2026-10-17T13:00:00.000Z' });

    expect(buttonNames()).toContain('Marcar como ausente');
  });

  it('offers nothing to somebody who cannot work with appointments', async () => {
    await opened({ roles: ['patient'] });

    expect(buttonNames()).not.toContain('Registrar llegada');
    expect(buttonNames()).not.toContain('Cancelar turno');
  });
});

describe('simple transitions', () => {
  it('confirms with the version the screen saw, and shows the result', async () => {
    const user = userEvent.setup();
    const app = await opened();

    await user.click(screen.getByRole('button', { name: 'Confirmar turno' }));

    await waitFor(() => {
      expect(app.posts).toEqual([{ path: 'confirm', body: { expectedVersion: 3 } }]);
    });
  });

  it('starts and finishes a consultation', async () => {
    const user = userEvent.setup();
    const app = await opened({ status: 'checked_in' });

    await user.click(screen.getByRole('button', { name: 'Iniciar consulta' }));

    await waitFor(() => {
      expect(app.posts).toEqual([{ path: 'start', body: { expectedVersion: 3 } }]);
    });
  });

  it('says the appointment changed meanwhile when the version is stale, and reloads it', async () => {
    const user = userEvent.setup();
    const app = await opened({
      routes: { [`POST /api/appointments/${ID}/confirm`]: () => problem(409, 'stale_revision') },
    });

    await user.click(screen.getByRole('button', { name: 'Confirmar turno' }));

    expect(await screen.findByText(/cambió mientras lo miraba/)).toBeInTheDocument();
    expect(
      app.requests.filter((request) => request === `GET /api/appointments/${ID}`).length,
    ).toBeGreaterThan(1);
  });
});

describe('check-in and the identity of the patient', () => {
  it('goes straight through when the identity is already confirmed', async () => {
    const user = userEvent.setup();
    const app = await opened();

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));

    await waitFor(() => {
      expect(app.posts).toEqual([{ path: 'check-in', body: { expectedVersion: 3 } }]);
    });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('asks reception to confirm the identity against the ID document', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      identityConfirmed: false,
      routes: {
        [`POST /api/appointments/${ID}/check-in`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            appointmentOf({
              status: 'checked_in',
              version: 4,
              identityConfirmed: true,
              identityConfirmation: 'staff',
            }),
          );
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));
    const panel = await screen.findByRole('group', { name: 'Llegada del paciente' });
    expect(within(panel).getByText(/Verifique el documento de identidad/)).toBeInTheDocument();
    await user.click(
      within(panel).getByRole('checkbox', { name: /Vi al paciente y su documento/ }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Confirmar llegada' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 3, confirmIdentity: true }]);
    });
  });

  it('lets reception check in without confirming, leaving the identity pending', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      identityConfirmed: false,
      routes: {
        [`POST /api/appointments/${ID}/check-in`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            appointmentOf({ status: 'checked_in', version: 4, identityConfirmed: false }),
          );
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar llegada' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 3 }]);
    });
  });

  it('words the confirmation for the professional of the appointment as a solo-practice step', async () => {
    const user = userEvent.setup();
    await opened({
      roles: ['professional'],
      ownProfessionalId: IDS.ana,
      identityConfirmed: false,
    });

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));

    const panel = await screen.findByRole('group', { name: 'Llegada del paciente' });
    expect(
      within(panel).getByText(/solo si usted es la única persona que atiende en la organización/i),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('checkbox', { name: /Confirmo en persona la identidad/ }),
    ).toBeInTheDocument();
  });

  it('says plainly when the confirmation was not accepted', async () => {
    const user = userEvent.setup();
    await opened({
      roles: ['professional'],
      ownProfessionalId: IDS.ana,
      identityConfirmed: false,
      routes: {
        [`POST /api/appointments/${ID}/check-in`]: () =>
          jsonResponse(
            appointmentOf({ status: 'checked_in', version: 4, identityConfirmed: false }),
          ),
      },
    });

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo en persona/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar llegada' }));

    expect(
      await screen.findByText(/Otra persona del equipo debe confirmar la identidad/),
    ).toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('asks who cancelled and why, and sends both with the version', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      routes: {
        [`POST /api/appointments/${ID}/cancel`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ status: 'cancelled', version: 4 }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Cancelar turno' }));
    const panel = await screen.findByRole('group', { name: 'Cancelar el turno' });
    await user.selectOptions(within(panel).getByLabelText('Quién cancela'), 'patient');
    await user.selectOptions(within(panel).getByLabelText('Motivo'), 'illness');
    await user.click(within(panel).getByRole('button', { name: 'Cancelar el turno' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { cancelledBy: 'patient', reasonCode: 'illness', expectedVersion: 3 },
      ]);
    });
  });

  it('wants a note when the reason is "other"', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      routes: {
        [`POST /api/appointments/${ID}/cancel`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ status: 'cancelled', version: 4 }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Cancelar turno' }));
    const panel = await screen.findByRole('group', { name: 'Cancelar el turno' });
    await user.selectOptions(within(panel).getByLabelText('Quién cancela'), 'organization');
    await user.selectOptions(within(panel).getByLabelText('Motivo'), 'other');
    const confirm = within(panel).getByRole('button', { name: 'Cancelar el turno' });
    expect(confirm).toBeDisabled();

    await user.type(within(panel).getByLabelText('Detalle'), 'Corte de luz');
    await user.click(confirm);

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          cancelledBy: 'organization',
          reasonCode: 'other',
          note: 'Corte de luz',
          expectedVersion: 3,
        },
      ]);
    });
  });
});

describe('rescheduling', () => {
  it('shows the free times of the professional and moves the appointment to the one chosen', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      routes: {
        [`POST /api/appointments/${ID}/reschedule`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            appointmentOf({
              version: 4,
              startsAt: '2026-10-18T13:30:00.000Z',
              endsAt: '2026-10-18T14:00:00.000Z',
            }),
          );
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Reprogramar' }));
    const panel = await screen.findByRole('group', { name: 'Reprogramar el turno' });
    fireEvent.change(within(panel).getByLabelText('Fecha'), { target: { value: '2026-10-18' } });
    const slots = await within(panel).findByRole('group', { name: 'Horarios disponibles' });
    await user.click(within(slots).getByRole('button', { name: '10:30' }));
    await user.click(within(panel).getByRole('button', { name: 'Reprogramar el turno' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 3, startsAt: '2026-10-18T13:30:00.000Z' }]);
    });
  });

  it('can hand the appointment to another professional', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      routes: {
        [`POST /api/appointments/${ID}/reschedule`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ version: 4, professionalId: IDS.beto }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Reprogramar' }));
    const panel = await screen.findByRole('group', { name: 'Reprogramar el turno' });
    await user.selectOptions(within(panel).getByLabelText('Profesional'), IDS.beto);
    fireEvent.change(within(panel).getByLabelText('Fecha'), { target: { value: '2026-10-18' } });
    const slots = await within(panel).findByRole('group', { name: 'Horarios disponibles' });
    await user.click(within(slots).getByRole('button', { name: '10:00' }));
    await user.click(within(panel).getByRole('button', { name: 'Reprogramar el turno' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { expectedVersion: 3, startsAt: '2026-10-18T13:00:00.000Z', professionalId: IDS.beto },
      ]);
    });
  });

  it('offers the next free times when the chosen one was taken', async () => {
    const user = userEvent.setup();
    await opened({
      routes: {
        [`POST /api/appointments/${ID}/reschedule`]: () =>
          problem(409, 'slot_taken', {
            conflict: { startsAt: '2026-10-18T13:00:00.000Z', endsAt: '2026-10-18T13:30:00.000Z' },
            nextSlots: [
              { startsAt: '2026-10-18T14:00:00.000Z', endsAt: '2026-10-18T14:30:00.000Z' },
            ],
          }),
      },
    });

    await user.click(screen.getByRole('button', { name: 'Reprogramar' }));
    const panel = await screen.findByRole('group', { name: 'Reprogramar el turno' });
    fireEvent.change(within(panel).getByLabelText('Fecha'), { target: { value: '2026-10-18' } });
    const slots = await within(panel).findByRole('group', { name: 'Horarios disponibles' });
    await user.click(within(slots).getByRole('button', { name: '10:00' }));
    await user.click(within(panel).getByRole('button', { name: 'Reprogramar el turno' }));

    const alert = await within(panel).findByRole('alert');
    expect(within(alert).getByText('Ese horario ya no está disponible')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: '11:00' })).toBeInTheDocument();
  });
});

describe('correcting a terminal status', () => {
  it('offers reception every status but the ones that speak for the consultation', async () => {
    const user = userEvent.setup();
    await opened({ status: 'no_show' });

    await user.click(screen.getByRole('button', { name: 'Corregir estado' }));
    const panel = await screen.findByRole('group', { name: 'Corregir el estado' });

    const options = within(within(panel).getByLabelText('Nuevo estado'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Programado', 'Confirmado', 'En sala', 'Cancelado']);
  });

  it('offers the professional of the appointment the consultation statuses too', async () => {
    const user = userEvent.setup();
    await opened({ status: 'no_show', roles: ['professional'], ownProfessionalId: IDS.ana });

    await user.click(screen.getByRole('button', { name: 'Corregir estado' }));
    const panel = await screen.findByRole('group', { name: 'Corregir el estado' });

    const options = within(within(panel).getByLabelText('Nuevo estado'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([
      'Programado',
      'Confirmado',
      'En sala',
      'En consulta',
      'Atendido',
      'Cancelado',
    ]);
  });

  it('needs a reason code and sends it with the optional note and the version', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      status: 'no_show',
      routes: {
        [`POST /api/appointments/${ID}/correct`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ status: 'confirmed', version: 4 }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Corregir estado' }));
    const panel = await screen.findByRole('group', { name: 'Corregir el estado' });
    await user.selectOptions(within(panel).getByLabelText('Nuevo estado'), 'confirmed');
    const apply = within(panel).getByRole('button', { name: 'Corregir el estado' });
    expect(apply).toBeDisabled();

    const reasons = within(within(panel).getByLabelText('Motivo de la corrección'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(reasons).toEqual([
      '',
      'Se marcó por error',
      'El paciente llegó tarde',
      'Se registró tarde',
      'Otro',
    ]);

    await user.selectOptions(
      within(panel).getByLabelText('Motivo de la corrección'),
      'entered_by_mistake',
    );
    expect(apply).toBeEnabled();
    await user.type(within(panel).getByLabelText('Detalle (opcional)'), 'Era otro paciente');
    await user.click(apply);

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          toStatus: 'confirmed',
          reasonCode: 'entered_by_mistake',
          note: 'Era otro paciente',
          expectedVersion: 3,
        },
      ]);
    });
  });

  it('leaves the note out of the request when there is none', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      status: 'no_show',
      routes: {
        [`POST /api/appointments/${ID}/correct`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ status: 'confirmed', version: 4 }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Corregir estado' }));
    const panel = await screen.findByRole('group', { name: 'Corregir el estado' });
    await user.selectOptions(within(panel).getByLabelText('Nuevo estado'), 'confirmed');
    await user.selectOptions(within(panel).getByLabelText('Motivo de la corrección'), 'other');
    await user.click(within(panel).getByRole('button', { name: 'Corregir el estado' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ toStatus: 'confirmed', reasonCode: 'other', expectedVersion: 3 }]);
    });
  });

  it('explains a refusal (403) instead of failing silently', async () => {
    const user = userEvent.setup();
    await opened({
      status: 'no_show',
      routes: { [`POST /api/appointments/${ID}/correct`]: () => problem(403, 'forbidden') },
    });

    await user.click(screen.getByRole('button', { name: 'Corregir estado' }));
    const panel = await screen.findByRole('group', { name: 'Corregir el estado' });
    await user.selectOptions(
      within(panel).getByLabelText('Motivo de la corrección'),
      'patient_arrived_late',
    );
    await user.click(within(panel).getByRole('button', { name: 'Corregir el estado' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(/No tiene permiso/);
  });
});

describe('an organization in read-only mode', () => {
  it('keeps cancelling available and explains why the rest is off', async () => {
    await opened({ readOnly: true });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancelar turno' })).toBeEnabled();
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar turno' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveAccessibleDescription('No disponible en modo de solo lectura.');
  });

  it('offers only the cancellation the patient asked for, because the API refuses the rest', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await opened({
      readOnly: true,
      routes: {
        [`POST /api/appointments/${ID}/cancel`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(appointmentOf({ status: 'cancelled', version: 4 }));
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Cancelar turno' }));
    const panel = await screen.findByRole('group', { name: 'Cancelar el turno' });
    const who = within(panel).getByLabelText('Quién cancela');
    expect(
      within(who)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['', 'El paciente']);
    expect(who).toHaveAccessibleDescription(
      'En modo de solo lectura solo se registra la cancelación que pidió el paciente.',
    );

    await user.selectOptions(who, 'patient');
    await user.selectOptions(within(panel).getByLabelText('Motivo'), 'illness');
    await user.click(within(panel).getByRole('button', { name: 'Cancelar el turno' }));
    await waitFor(() => {
      expect(bodies).toEqual([
        { cancelledBy: 'patient', reasonCode: 'illness', expectedVersion: 3 },
      ]);
    });
  });

  it('keeps the three options of who cancels when the organization is not read-only', async () => {
    const user = userEvent.setup();
    await opened();

    await user.click(screen.getByRole('button', { name: 'Cancelar turno' }));
    const panel = await screen.findByRole('group', { name: 'Cancelar el turno' });
    const who = within(panel).getByLabelText('Quién cancela');
    expect(
      within(who)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['', 'El paciente', 'El profesional', 'La organización']);
    expect(who).not.toHaveAccessibleDescription();
  });
});

describe('accessibility', () => {
  it('has no violations with the drawer, the history and an open panel', async () => {
    const user = userEvent.setup();
    await opened({ identityConfirmed: false });
    await screen.findByRole('list', { name: 'Historial del turno' });
    expect(await a11yViolations(screen.getByRole('dialog'))).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Registrar llegada' }));
    await screen.findByRole('group', { name: 'Llegada del paciente' });
    expect(await a11yViolations(screen.getByRole('dialog'))).toEqual([]);
  });
});

describe('starting the consultation from the appointment (D20)', () => {
  const PROFESSIONAL = { roles: ['professional'] as Role[], ownProfessionalId: IDS.ana };

  it('links an appointment in progress to the new encounter, tied to it', async () => {
    await opened({ ...PROFESSIONAL, status: 'in_progress' });

    const link = within(screen.getByRole('dialog')).getByRole('link', {
      name: 'Iniciar consulta',
    });
    const target = new URL(link.getAttribute('href') ?? '', 'http://app.test');
    expect(target.pathname).toBe('/encounters/new');
    expect(target.searchParams.get('patientId')).toBe(IDS.patientGomez);
    expect(target.searchParams.get('appointmentId')).toBe(ID);
  });

  it('starts the appointment and goes to the new encounter from "checked in"', async () => {
    const user = userEvent.setup();
    const app = await opened({ ...PROFESSIONAL, status: 'checked_in' });

    await user.click(screen.getByRole('button', { name: 'Iniciar consulta' }));

    await waitFor(() => {
      expect(app.posts).toEqual([{ path: 'start', body: { expectedVersion: 3 } }]);
    });
  });

  it.each<[string, Mount]>([
    ['reception, who is not the professional', { roles: ['reception'], status: 'in_progress' }],
    [
      'another professional',
      { ...PROFESSIONAL, ownProfessionalId: IDS.beto, status: 'in_progress' },
    ],
    [
      'an identity nobody confirmed',
      { ...PROFESSIONAL, status: 'in_progress', identityConfirmed: false },
    ],
    ['a read-only organization', { ...PROFESSIONAL, status: 'in_progress', readOnly: true }],
    ['an appointment not yet started', { ...PROFESSIONAL, status: 'confirmed' }],
    ['a finished appointment', { ...PROFESSIONAL, status: 'attended' }],
  ])('is not offered to %s', async (_name, options) => {
    await opened(options);

    expect(screen.queryByRole('link', { name: 'Iniciar consulta' })).not.toBeInTheDocument();
  });
});

describe('appointment drawer: pieces that features register (slot appointment-drawer)', () => {
  const registry = createRegistry({
    routes: {},
    nav: {},
    slots: {
      '../features/messaging/slots.tsx': {
        default: [
          {
            slot: 'appointment-drawer',
            id: 'message-log',
            Component: ({ appointment }: { appointment: { id: string; patientName: string } }) => (
              <p>
                Message log of {appointment.patientName} ({appointment.id})
              </p>
            ),
          },
        ],
      },
    },
  });

  it('shows the piece of a feature inside the drawer, with the appointment it is open on', async () => {
    mount({ registry });

    expect(
      await screen.findByText(`Message log of ${entry().patientName} (${ID})`),
    ).toBeInTheDocument();
  });

  it('shows nothing extra when no feature registered a piece', async () => {
    mount();

    await screen.findByRole('dialog');
    expect(screen.queryByText(/Message log of/)).not.toBeInTheDocument();
  });
});
