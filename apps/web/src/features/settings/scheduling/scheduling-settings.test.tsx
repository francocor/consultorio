import type { AppointmentTypeDto, BlockDto, HolidayDto } from '@consultorio/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../shared/test/fixtures.js';
import { renderApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';
import { IDS, LOCATIONS, PROFESSIONALS, TYPES } from '../../calendar/fixtures.js';

const INACTIVE_TYPE: AppointmentTypeDto = {
  ...(TYPES[1] as AppointmentTypeDto),
  id: '0190a000-0000-7000-8000-0000000000d9',
  name: 'Chequeo anual',
  active: false,
};

const BLOCK: BlockDto = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  professionalId: IDS.ana,
  locationId: null,
  startsAt: '2026-12-20T03:00:00.000Z',
  endsAt: '2027-01-01T03:00:00.000Z',
  reason: 'Vacaciones',
  seriesId: null,
};
const SERIES_BLOCK: BlockDto = {
  id: '0190a000-0000-7000-8000-0000000000b2',
  professionalId: null,
  locationId: IDS.central,
  startsAt: '2026-11-03T15:00:00.000Z',
  endsAt: '2026-11-03T17:00:00.000Z',
  reason: 'Reunión de equipo',
  seriesId: '0190a000-0000-7000-8000-0000000000b3',
};

const HOLIDAYS: HolidayDto[] = [
  { day: '2026-12-25', name: 'Navidad', source: 'national', locationId: null, dayOffId: null },
  {
    day: '2026-12-07',
    name: 'Puente turístico',
    source: 'bridge',
    locationId: null,
    dayOffId: null,
  },
  {
    day: '2026-11-11',
    name: 'Aniversario de la sede',
    source: 'organization',
    locationId: IDS.central,
    dayOffId: '0190a000-0000-7000-8000-0000000000f9',
  },
];

interface OpenOptions {
  me?: ReturnType<typeof meFor>;
  routes?: Record<string, FetchHandler | Response>;
}

function open(options: OpenOptions = {}) {
  const urls: string[] = [];
  const app = renderApp({
    me: options.me ?? meFor(['owner']),
    path: '/settings/scheduling',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/appointment-types': (url) => {
        urls.push(url);
        return jsonResponse({
          types: url.includes('includeInactive=true') ? [...TYPES, INACTIVE_TYPE] : TYPES,
        });
      },
      'GET /api/schedule-blocks': () => jsonResponse({ blocks: [BLOCK, SERIES_BLOCK] }),
      'GET /api/holidays': (url) => {
        urls.push(url);
        return jsonResponse({ year: 2026, holidays: HOLIDAYS });
      },
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      'GET /api/appointments': () => jsonResponse({ appointments: [], blocks: [], holidays: [] }),
      ...options.routes,
    },
  });
  return { ...app, urls };
}

async function section(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('tab', { name }));
  return screen.findByRole('tabpanel', { name });
}

describe('the settings area', () => {
  it('has a section for scheduling that opens on the appointment types', async () => {
    const app = open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones de configuración' });
    expect(within(nav).getByRole('link', { name: 'Turnos' })).toBeInTheDocument();
    expect(
      await screen.findByRole('tab', { name: 'Tipos de turno', selected: true }),
    ).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('is for people who configure scheduling: reception does not see the section nor the page', async () => {
    open({ me: meFor(['reception']) });

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = open();
    await screen.findByText('Primera consulta');

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('appointment types', () => {
  it('lists each type with its length, buffer, mode, approval and state in words', async () => {
    open();

    const first = (await screen.findByText('Primera consulta')).closest('li');
    expect(first).not.toBeNull();
    const card = within(first as HTMLElement);
    expect(card.getByText('45 min')).toBeInTheDocument();
    expect(card.getByText('Presencial')).toBeInTheDocument();
    expect(card.getByText('Activo')).toBeInTheDocument();
    const control = within(screen.getByText('Control').closest('li') as HTMLElement);
    expect(control.getByText('10 min de margen después')).toBeInTheDocument();
  });

  it('creates a type with a name and a duration', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/appointment-types': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            { ...TYPES[0], id: '0190a000-0000-7000-8000-0000000000da', name: 'Estudio' },
            201,
          );
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Nuevo tipo de turno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo tipo de turno' });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Estudio');
    await user.type(within(dialog).getByLabelText('Duración (minutos)'), '40');
    await user.click(within(dialog).getByRole('button', { name: 'Crear tipo' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          name: 'Estudio',
          description: null,
          durationMinutes: 40,
          bufferMinutes: 0,
          mode: 'in_person',
          requiresApproval: false,
          color: null,
          professionalIds: [],
          specialties: [],
        },
      ]);
    });
  });

  it('explains a duration of zero beside the field and sends nothing', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/appointment-types': (_url, init) => jsonResponse(bodies.push(jsonBody(init))),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Nuevo tipo de turno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo tipo de turno' });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Estudio');
    await user.type(within(dialog).getByLabelText('Duración (minutos)'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Crear tipo' }));

    expect(
      await within(dialog).findByText('La duración tiene que ser mayor que cero.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Duración (minutos)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(bodies).toEqual([]);
  });

  it('edits a type and sends only what changed', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`PATCH /api/appointment-types/${IDS.control}`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...TYPES[1], durationMinutes: 25 });
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Editar Control' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar tipo de turno' });
    const duration = within(dialog).getByLabelText('Duración (minutos)');
    await user.clear(duration);
    await user.type(duration, '25');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ durationMinutes: 25 }]);
    });
  });

  it('can limit a type to some professionals', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/appointment-types': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(TYPES[0], 201);
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Nuevo tipo de turno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo tipo de turno' });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Pediátrico');
    await user.type(within(dialog).getByLabelText('Duración (minutos)'), '30');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Dr. Beto Ruiz' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear tipo' }));

    await waitFor(() => {
      expect(bodies[0]).toMatchObject({ professionalIds: [IDS.beto] });
    });
  });

  it('deactivates after confirming, and the old appointments keep their type', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      routes: {
        [`POST /api/appointment-types/${IDS.control}/deactivate`]: () => {
          calls.push('deactivate');
          return jsonResponse({ ...TYPES[1], active: false });
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Desactivar Control' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/Los turnos que ya existen conservan este tipo/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Desactivar tipo' }));

    await waitFor(() => {
      expect(calls).toEqual(['deactivate']);
    });
  });

  it('shows the inactive types on request and offers to reactivate them', async () => {
    const user = userEvent.setup();
    const app = open();
    await screen.findByText('Primera consulta');

    await user.click(screen.getByRole('switch', { name: 'Mostrar tipos inactivos' }));

    const inactive = (await screen.findByText('Chequeo anual')).closest('li');
    expect(within(inactive as HTMLElement).getByText('Inactivo')).toBeInTheDocument();
    expect(
      within(inactive as HTMLElement).getByRole('button', { name: 'Reactivar Chequeo anual' }),
    ).toBeInTheDocument();
    expect(app.urls.some((url) => url.includes('includeInactive=true'))).toBe(true);
  });

  it('shows what the server refused', async () => {
    const user = userEvent.setup();
    open({
      routes: { 'POST /api/appointment-types': () => problemResponse(403, 'forbidden') },
    });

    await user.click(await screen.findByRole('button', { name: 'Nuevo tipo de turno' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nombre'), 'Estudio');
    await user.type(within(dialog).getByLabelText('Duración (minutos)'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Crear tipo' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No tiene permiso');
  });
});

describe('blocks', () => {
  it('lists the upcoming blocks with who they are for, when and why', async () => {
    const user = userEvent.setup();
    open();

    const panel = await section(user, 'Bloqueos');
    const vacation = within(within(panel).getByText('Vacaciones').closest('li') as HTMLElement);
    expect(vacation.getByText('Dra. Ana Pérez')).toBeInTheDocument();
    expect(vacation.getByText(/20\/12\/2026/)).toBeInTheDocument();
    const team = within(within(panel).getByText('Reunión de equipo').closest('li') as HTMLElement);
    expect(team.getByText('Sede Central')).toBeInTheDocument();
    expect(team.getByText('Se repite')).toBeInTheDocument();
  });

  it('blocks a professional for whole days, in the time zone of the location', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/schedule-blocks': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ blocks: [BLOCK] }, 201);
        },
      },
    });

    await section(user, 'Bloqueos');
    await user.click(screen.getByRole('button', { name: 'Nuevo bloqueo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo bloqueo' });
    await user.selectOptions(within(dialog).getByLabelText('Profesional'), IDS.ana);
    fireEvent.change(within(dialog).getByLabelText('Desde el día'), {
      target: { value: '2026-12-20' },
    });
    fireEvent.change(within(dialog).getByLabelText('Hasta el día'), {
      target: { value: '2026-12-31' },
    });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Vacaciones');
    await user.click(within(dialog).getByRole('button', { name: 'Crear bloqueo' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          professionalId: IDS.ana,
          startsAt: '2026-12-20T03:00:00.000Z',
          endsAt: '2027-01-01T03:00:00.000Z',
          reason: 'Vacaciones',
        },
      ]);
    });
  });

  it('can block part of a day and repeat it weekly', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/schedule-blocks': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ blocks: [SERIES_BLOCK] }, 201);
        },
      },
    });

    await section(user, 'Bloqueos');
    await user.click(screen.getByRole('button', { name: 'Nuevo bloqueo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo bloqueo' });
    await user.selectOptions(within(dialog).getByLabelText('Para'), 'location');
    await user.selectOptions(within(dialog).getByLabelText('Sede'), IDS.central);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Todo el día' }));
    fireEvent.change(within(dialog).getByLabelText('Desde el día'), {
      target: { value: '2026-11-03' },
    });
    fireEvent.change(within(dialog).getByLabelText('Desde las'), { target: { value: '12:00' } });
    fireEvent.change(within(dialog).getByLabelText('Hasta las'), { target: { value: '14:00' } });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Reunión de equipo');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Repetir todas las semanas' }));
    fireEvent.change(within(dialog).getByLabelText('Cantidad de repeticiones'), {
      target: { value: '4' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Crear bloqueo' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          locationId: IDS.central,
          startsAt: '2026-11-03T15:00:00.000Z',
          endsAt: '2026-11-03T17:00:00.000Z',
          reason: 'Reunión de equipo',
          recurrence: { frequency: 'weekly', count: 4 },
        },
      ]);
    });
  });

  it('lists the appointments inside the block and does not touch them', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'GET /api/appointments': () =>
          jsonResponse({
            appointments: [
              {
                id: IDS.appointmentGomez,
                patientId: IDS.patientGomez,
                professionalId: IDS.ana,
                locationId: IDS.central,
                appointmentTypeId: IDS.control,
                startsAt: '2026-12-22T13:00:00.000Z',
                endsAt: '2026-12-22T13:30:00.000Z',
                bufferMinutes: 0,
                status: 'confirmed',
                source: 'staff',
                bookedBy: null,
                identityConfirmed: true,
                identityConfirmation: null,
                outOfHours: false,
                seriesId: null,
                seriesIndex: null,
                version: 1,
                patientName: 'Gómez, Valentina',
                typeName: 'Control',
                typeColor: null,
              },
            ],
            blocks: [],
            holidays: [],
          }),
        'POST /api/schedule-blocks': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ blocks: [BLOCK] }, 201);
        },
      },
    });

    await section(user, 'Bloqueos');
    await user.click(screen.getByRole('button', { name: 'Nuevo bloqueo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo bloqueo' });
    await user.selectOptions(within(dialog).getByLabelText('Profesional'), IDS.ana);
    fireEvent.change(within(dialog).getByLabelText('Desde el día'), {
      target: { value: '2026-12-20' },
    });
    fireEvent.change(within(dialog).getByLabelText('Hasta el día'), {
      target: { value: '2026-12-31' },
    });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Vacaciones');

    const affected = await within(dialog).findByRole('list', { name: 'Turnos dentro del bloqueo' });
    expect(within(affected).getByText(/Gómez, Valentina/)).toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: 'Crear bloqueo' });
    expect(create).toBeDisabled();

    await user.click(
      within(dialog).getByRole('checkbox', { name: /Entiendo que estos turnos siguen vigentes/ }),
    );
    await user.click(create);

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
  });

  it('removes a single block, and asks whether to remove one or the whole series', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      routes: {
        [`DELETE /api/schedule-blocks/${BLOCK.id}`]: (url) => {
          calls.push(url);
          return new Response(null, { status: 204 });
        },
        [`DELETE /api/schedule-blocks/${SERIES_BLOCK.id}`]: (url) => {
          calls.push(url);
          return new Response(null, { status: 204 });
        },
      },
    });

    const panel = await section(user, 'Bloqueos');
    await user.click(within(panel).getByRole('button', { name: 'Quitar el bloqueo Vacaciones' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Quitar bloqueo',
      }),
    );
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toContain('scope=occurrence');

    await user.click(
      within(panel).getByRole('button', { name: 'Quitar el bloqueo Reunión de equipo' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Toda la serie' }));
    await user.click(within(dialog).getByRole('button', { name: 'Quitar bloqueo' }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]).toContain('scope=series');
  });
});

describe('holidays and days off', () => {
  it('shows each day with where it comes from, in words', async () => {
    const user = userEvent.setup();
    open();

    const panel = await section(user, 'Feriados y días no laborables');
    const christmas = within(within(panel).getByText('Navidad').closest('li') as HTMLElement);
    expect(christmas.getByText('Feriado nacional')).toBeInTheDocument();
    expect(christmas.getByText(/25\/12\/2026/)).toBeInTheDocument();
    expect(
      within(within(panel).getByText('Puente turístico').closest('li') as HTMLElement).getByText(
        'Día puente',
      ),
    ).toBeInTheDocument();
    const own = within(
      within(panel).getByText('Aniversario de la sede').closest('li') as HTMLElement,
    );
    expect(own.getByText('Día no laborable de la organización')).toBeInTheDocument();
    expect(own.getByText('Sede Central')).toBeInTheDocument();
  });

  it('offers to remove only the days the organization added', async () => {
    const user = userEvent.setup();
    open();

    const panel = await section(user, 'Feriados y días no laborables');

    expect(
      within(panel).getByRole('button', { name: 'Quitar Aniversario de la sede' }),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Quitar Navidad' })).not.toBeInTheDocument();
  });

  it('adds a day off for the whole organization or one location', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        'POST /api/days-off': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            {
              id: HOLIDAYS[2]?.dayOffId,
              day: '2026-11-30',
              name: 'Cierre por obras',
              locationId: null,
            },
            201,
          );
        },
      },
    });

    const panel = await section(user, 'Feriados y días no laborables');
    await user.click(within(panel).getByRole('button', { name: 'Agregar día no laborable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar día no laborable' });
    fireEvent.change(within(dialog).getByLabelText('Día'), { target: { value: '2026-11-30' } });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Cierre por obras');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ day: '2026-11-30', name: 'Cierre por obras' }]);
    });
  });

  it('removes a day off after confirming', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      routes: {
        [`DELETE /api/days-off/${HOLIDAYS[2]?.dayOffId ?? ''}`]: () => {
          calls.push('removed');
          return new Response(null, { status: 204 });
        },
      },
    });

    const panel = await section(user, 'Feriados y días no laborables');
    await user.click(within(panel).getByRole('button', { name: 'Quitar Aniversario de la sede' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Quitar día' }),
    );

    await waitFor(() => {
      expect(calls).toEqual(['removed']);
    });
  });

  it('looks at another year', async () => {
    const user = userEvent.setup();
    const app = open();

    const panel = await section(user, 'Feriados y días no laborables');
    await user.click(within(panel).getByRole('button', { name: 'Año siguiente' }));

    const next = new Date().getFullYear() + 1;
    await waitFor(() => {
      expect(
        app.urls.some((url) => url.includes('/holidays') && url.includes(`year=${String(next)}`)),
      ).toBe(true);
    });
  });
});

describe('overbooking', () => {
  const profile = (maxSimultaneous: number) => ({
    id: IDS.ana,
    membershipId: IDS.anaMembership,
    fullName: 'Dra. Ana Pérez',
    status: 'active',
    specialties: ['Cardiología'],
    matricula: { jurisdiction: 'AR-C', number: '41258', status: 'verified' },
    maxSimultaneous,
    clinicalAccess: true,
  });
  const profiles: Record<string, FetchHandler> = {
    [`GET /api/staff/${IDS.anaMembership}/professional-profile`]: () => jsonResponse(profile(1)),
    [`GET /api/staff/${IDS.betoMembership}/professional-profile`]: () =>
      jsonResponse({
        ...profile(2),
        id: IDS.beto,
        membershipId: IDS.betoMembership,
        fullName: 'Dr. Beto Ruiz',
        specialties: ['Pediatría'],
      }),
  };

  it('shows how many simultaneous appointments each professional accepts', async () => {
    const user = userEvent.setup();
    open({ routes: profiles });

    const panel = await section(user, 'Sobreturnos');

    expect(await within(panel).findByLabelText('Turnos simultáneos de Dra. Ana Pérez')).toHaveValue(
      1,
    );
    expect(within(panel).getByLabelText('Turnos simultáneos de Dr. Beto Ruiz')).toHaveValue(2);
    expect(within(panel).getByText('Sin sobreturnos')).toBeInTheDocument();
  });

  it('asks for confirmation before allowing two or more at the same time', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        ...profiles,
        [`PUT /api/staff/${IDS.anaMembership}/professional-profile`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(profile(2));
        },
      },
    });

    const panel = await section(user, 'Sobreturnos');
    const input = await within(panel).findByLabelText('Turnos simultáneos de Dra. Ana Pérez');
    await user.clear(input);
    await user.type(input, '2');
    await user.click(within(panel).getByRole('button', { name: 'Guardar Dra. Ana Pérez' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/turnos al mismo tiempo/)).toBeInTheDocument();
    expect(bodies).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Permitir sobreturnos' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        {
          fullName: 'Dra. Ana Pérez',
          specialties: ['Cardiología'],
          matricula: { jurisdiction: 'AR-C', number: '41258' },
          maxSimultaneous: 2,
        },
      ]);
    });
  });

  it('goes back to one without asking', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        ...profiles,
        [`PUT /api/staff/${IDS.betoMembership}/professional-profile`]: (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(profile(1));
        },
      },
    });

    const panel = await section(user, 'Sobreturnos');
    const input = await within(panel).findByLabelText('Turnos simultáneos de Dr. Beto Ruiz');
    await user.clear(input);
    await user.type(input, '1');
    await user.click(within(panel).getByRole('button', { name: 'Guardar Dr. Beto Ruiz' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('refuses a number outside 1 to 20', async () => {
    const user = userEvent.setup();
    open({ routes: profiles });

    const panel = await section(user, 'Sobreturnos');
    const input = await within(panel).findByLabelText('Turnos simultáneos de Dra. Ana Pérez');
    await user.clear(input);
    await user.type(input, '40');
    await user.click(within(panel).getByRole('button', { name: 'Guardar Dra. Ana Pérez' }));

    expect(await within(panel).findByText('Indique un número del 1 al 20.')).toBeInTheDocument();
  });
});
