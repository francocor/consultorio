import type {
  AppointmentTypeDto,
  PatientSummaryDto,
  WaitlistCallItemDto,
  WaitlistCallListResponse,
  WaitlistEntryDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

const ids = {
  entry: '0190a000-0000-7000-8000-0000000000a1',
  second: '0190a000-0000-7000-8000-0000000000a2',
  patient: '0190a000-0000-7000-8000-0000000000b1',
  type: '0190a000-0000-7000-8000-0000000000c1',
  professional: '0190a000-0000-7000-8000-0000000000d1',
  location: '0190a000-0000-7000-8000-0000000000e1',
  offer: '0190a000-0000-7000-8000-0000000000f1',
  item: '0190a000-0000-7000-8000-0000000000f2',
};

const entry = (overrides: Partial<WaitlistEntryDto> = {}): WaitlistEntryDto => ({
  id: ids.entry,
  patientId: ids.patient,
  patientName: 'Lucía Fernández',
  appointmentTypeId: ids.type,
  appointmentTypeName: 'Control',
  professionalId: ids.professional,
  professionalName: 'Dra. Ríos',
  locationId: null,
  locationName: null,
  weekdays: [1, 4],
  timeRanges: [{ from: '08:00', to: '12:00' }],
  earliestDate: null,
  latestDate: null,
  status: 'active',
  closeReason: null,
  closedAt: null,
  expiresAt: '2031-07-04T12:00:00.000Z',
  manualContactOnly: false,
  manualReason: null,
  offersOptInAt: '2031-05-05T12:00:00.000Z',
  offersOptInSource: 'staff',
  channels: ['email'],
  priority: 0,
  unresponsive: false,
  consecutiveExpired: 0,
  source: 'staff',
  createdAt: '2031-05-05T12:00:00.000Z',
  openOffer: null,
  ...overrides,
});

const callItem = (overrides: Partial<WaitlistCallItemDto> = {}): WaitlistCallItemDto => ({
  worklistItemId: ids.item,
  reason: 'manual_contact_only',
  entry: entry({
    id: ids.second,
    patientName: 'Mario Pérez',
    manualContactOnly: true,
    manualReason: 'no_offers_opt_in',
    offersOptInAt: null,
    offersOptInSource: null,
  }),
  contact: { phone: '+54 11 5555 0000', email: 'mario@example.test' },
  slot: {
    startsAt: '2031-05-19T13:00:00.000Z',
    endsAt: '2031-05-19T13:30:00.000Z',
    professionalId: ids.professional,
    professionalName: 'Dra. Ríos',
    locationId: ids.location,
    locationName: 'Centro',
    timeZone: 'America/Argentina/Buenos_Aires',
  },
  ...overrides,
});

const calls = (overrides: Partial<WaitlistCallListResponse> = {}): WaitlistCallListResponse => ({
  items: [],
  unresponsive: [],
  ...overrides,
});

const type: AppointmentTypeDto = {
  id: ids.type,
  name: 'Control',
  description: null,
  durationMinutes: 30,
  bufferMinutes: 0,
  mode: 'in_person',
  priceReference: null,
  requiresApproval: false,
  color: null,
  professionalIds: [],
  specialties: [],
  active: true,
};

const patient: PatientSummaryDto = {
  id: ids.patient,
  familyName: 'Fernández',
  givenNames: 'Lucía',
  birthDate: '1990-04-02',
  document: { type: 'dni', number: '30111222' },
  phone: '+54 11 5555 0000',
  status: 'active',
  hasSafetyFlag: false,
};

const staff = {
  staff: [
    {
      membershipId: '0190a000-0000-7000-8000-0000000000d2',
      displayName: 'Dra. Ríos',
      roles: ['professional'],
      status: 'active',
      email: 'rios@example.test',
      locations: [{ id: ids.location, name: 'Centro' }],
      professional: { id: ids.professional, status: 'active', specialties: [], matricula: null },
    },
  ],
};

type Routes = Record<string, ((url: string, init: RequestInit) => Response) | Response>;

let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  routes: Routes = {},
  options: { list?: WaitlistEntryDto[]; calls?: WaitlistCallListResponse; readOnly?: boolean } = {},
) {
  const app = renderApp({
    path: '/waitlist',
    me: meFor(['reception'], options.readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/waitlist': () => jsonResponse({ entries: options.list ?? [] }),
      'GET /api/waitlist/to-call': () => jsonResponse(options.calls ?? calls()),
      'GET /api/appointment-types': () => jsonResponse({ types: [type] }),
      'GET /api/staff': () => jsonResponse(staff),
      'GET /api/locations': () =>
        jsonResponse({
          locations: [
            {
              id: ids.location,
              name: 'Centro',
              timeZone: 'America/Argentina/Buenos_Aires',
              active: true,
            },
          ],
        }),
      'GET /api/patients': () => jsonResponse({ patients: [patient], nextCursor: null }),
      ...routes,
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('the waitlist screen', () => {
  it('says there is nobody on the list, and why that matters', async () => {
    open();

    expect(
      await screen.findByRole('heading', { name: 'No hay nadie en la lista de espera' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Lista de espera' })).toBeVisible();
  });

  it('shows each entry with what it waits for, when, how and where it stands', async () => {
    open(
      {},
      {
        list: [
          entry({
            channels: ['email', 'whatsapp'],
            earliestDate: '2031-06-01',
            latestDate: '2031-06-30',
          }),
          entry({
            id: ids.second,
            patientName: 'Mario Pérez',
            professionalId: null,
            professionalName: null,
            weekdays: [],
            timeRanges: [],
            status: 'paused',
          }),
        ],
      },
    );

    const list = await screen.findByRole('list', { name: 'Esperas' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Lucía Fernández');
    expect(first).toHaveTextContent('Control · Dra. Ríos · Cualquier sede');
    expect(first).toHaveTextContent('lun, jue');
    expect(first).toHaveTextContent('08:00 a 12:00');
    expect(first).toHaveTextContent('Del 01/06/2031 al 30/06/2031');
    expect(first).toHaveTextContent('Correo electrónico, WhatsApp');
    expect(first).toHaveTextContent('En espera');
    expect(second).toHaveTextContent('Mario Pérez');
    expect(second).toHaveTextContent('Cualquier profesional');
    expect(second).toHaveTextContent('Pausada');
    expect(second).toHaveTextContent('Cualquiera');
  });

  it('says when an entry is manual contact only, has an offer open, got a priority or stopped answering', async () => {
    open(
      {},
      {
        list: [
          entry({
            manualContactOnly: true,
            manualReason: 'no_offers_opt_in',
            offersOptInAt: null,
            offersOptInSource: null,
          }),
          entry({
            id: ids.second,
            patientName: 'Mario Pérez',
            status: 'offered',
            priority: 2,
            unresponsive: true,
            consecutiveExpired: 3,
            openOffer: {
              id: ids.offer,
              status: 'open',
              endReason: null,
              professionalId: ids.professional,
              locationId: ids.location,
              startsAt: '2031-05-19T13:00:00.000Z',
              endsAt: '2031-05-19T13:30:00.000Z',
              createdAt: '2031-05-19T12:00:00.000Z',
              expiresAt: '2031-05-19T12:30:00.000Z',
              closedAt: null,
              channel: 'email',
              appointmentId: null,
            },
          }),
        ],
      },
    );

    const list = await screen.findByRole('list', { name: 'Esperas' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Solo contacto manual');
    expect(first).toHaveTextContent('No aceptó recibir ofertas. Hay que llamarlo');
    expect(second).toHaveTextContent('Con oferta abierta');
    expect(second).toHaveTextContent('Oferta abierta para el 19/05/2031, 10:00');
    expect(second).toHaveTextContent('hasta las 09:30');
    expect(second).toHaveTextContent('Urgente');
    expect(second).toHaveTextContent('No respondió las últimas 3 ofertas');
  });

  it('shows a closed entry with its reason and nothing to do with it', async () => {
    open(
      {},
      {
        list: [
          entry({
            status: 'closed',
            closeReason: 'fulfilled',
            closedAt: '2031-05-20T12:00:00.000Z',
          }),
        ],
      },
    );

    const card = (await screen.findByRole('list', { name: 'Esperas' })).querySelector('li');
    expect(card).toHaveTextContent('Cerrada');
    expect(card).toHaveTextContent('Turno asignado');
    expect(within(card as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });

  it('asks the server for the entries of the filter that was chosen', async () => {
    const urls: string[] = [];
    const user = userEvent.setup();
    open({
      'GET /api/waitlist': (url) => {
        urls.push(url);
        return jsonResponse({ entries: [] });
      },
    });
    await screen.findByRole('heading', { name: 'No hay nadie en la lista de espera' });

    await user.selectOptions(screen.getByLabelText('Mostrar'), 'Pausada');
    await user.click(screen.getByRole('checkbox', { name: 'Solo las que no responden' }));

    await waitFor(() => {
      expect(urls.at(-1)).toContain('status=paused');
      expect(urls.at(-1)).toContain('unresponsive=true');
    });
  });
});

describe('getting to the waitlist', () => {
  it('has its own entry in the navigation of reception, which opens the screen', async () => {
    open();

    await screen.findByRole('heading', { level: 1, name: 'Lista de espera' });
    const links = screen.getAllByRole('link', { name: 'Lista de espera' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', '/waitlist');
  });
});

describe('the slots to call', () => {
  it('lists each freed slot with the patient, how to call them and why it was not offered', async () => {
    open({}, { calls: calls({ items: [callItem()] }) });

    const panel = await screen.findByRole('region', { name: 'Turnos para ofrecer por teléfono' });
    expect(panel).toHaveTextContent('19/05/2031, 10:00 a 10:30 · Dra. Ríos · Centro');
    expect(panel).toHaveTextContent('Mario Pérez');
    expect(panel).toHaveTextContent('Solo contacto manual');
    expect(within(panel).getByRole('link', { name: '+54 11 5555 0000' })).toHaveAttribute(
      'href',
      'tel:+541155550000',
    );
    expect(panel).toHaveTextContent('mario@example.test');
  });

  it('says why a slot starting soon was not offered, and when there is no way to reach the patient', async () => {
    open(
      {},
      {
        calls: calls({
          items: [
            callItem({
              reason: 'slot_too_close',
              contact: { phone: null, email: null },
            }),
          ],
        }),
      },
    );

    const panel = await screen.findByRole('region', { name: 'Turnos para ofrecer por teléfono' });
    expect(panel).toHaveTextContent('El turno es muy pronto para ofrecerlo por mensaje');
    expect(panel).toHaveTextContent('Sin teléfono ni correo en la ficha.');
  });

  it('is not shown when there is nothing to call', async () => {
    open({}, { list: [entry()] });

    await screen.findByRole('list', { name: 'Esperas' });
    expect(screen.queryByRole('region', { name: 'Turnos para ofrecer por teléfono' })).toBeNull();
  });

  it('points at the entries that stopped answering and shows only them on request', async () => {
    const user = userEvent.setup();
    open(
      {},
      { calls: calls({ unresponsive: [entry({ unresponsive: true, consecutiveExpired: 3 })] }) },
    );

    expect(await screen.findByText('1 paciente no respondió las últimas ofertas.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ver quiénes son' }));

    expect(screen.getByRole('checkbox', { name: 'Solo las que no responden' })).toBeChecked();
  });
});

describe('adding a patient', () => {
  it('sends the patient, what they wait for, when they can come and the agreement', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'POST /api/waitlist': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(entry(), 201);
      },
    });
    await screen.findByRole('heading', { name: 'No hay nadie en la lista de espera' });

    await user.click(screen.getByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar a la lista de espera' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente' }), 'fern');
    await user.click(await within(dialog).findByRole('option', { name: /Fernández, Lucía/ }));
    await user.selectOptions(within(dialog).getByLabelText('Tipo de turno'), 'Control');
    await user.selectOptions(within(dialog).getByLabelText('Profesional'), 'Dra. Ríos');
    await user.click(within(dialog).getByRole('checkbox', { name: 'lunes' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'jueves' }));
    await user.click(within(dialog).getByRole('button', { name: 'Mañana (8 a 12)' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: /El paciente aceptó recibir ofertas/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Agregar a la lista' }));

    await waitFor(() => {
      expect(body).toEqual({
        patientId: ids.patient,
        appointmentTypeId: ids.type,
        professionalId: ids.professional,
        locationId: null,
        weekdays: [1, 4],
        timeRanges: [{ from: '08:00', to: '12:00' }],
        earliestDate: null,
        latestDate: null,
        offersOptIn: true,
        channels: ['email'],
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('warns that an entry without the agreement is kept for calling, and records no agreement', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    open({
      'POST /api/waitlist': (_url, init) => {
        body = jsonBody(init) as Record<string, unknown>;
        return jsonResponse(entry(), 201);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente' }), 'fern');
    await user.click(await within(dialog).findByRole('option', { name: /Fernández, Lucía/ }));
    await user.selectOptions(within(dialog).getByLabelText('Tipo de turno'), 'Control');

    expect(within(dialog).getByText(/Sin esa aceptación no se le envían ofertas/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Agregar a la lista' }));

    await waitFor(() => {
      expect(body?.['offersOptIn']).toBe(false);
    });
  });

  it('will not send until a patient and a type are chosen, or while a range is half typed', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Agregar a la lista' });

    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente' }), 'fern');
    await user.click(await within(dialog).findByRole('option', { name: /Fernández, Lucía/ }));
    expect(submit).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Tipo de turno'), 'Control');
    expect(submit).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Otra franja' }));
    expect(submit).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Cada franja necesita una hora de inicio y una de fin',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Quitar la franja 1' }));
    expect(submit).toBeEnabled();
  });

  it('explains a duplicate in plain words and keeps the dialog open', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/waitlist': () => problemResponse(409, 'conflict') });
    await user.click(await screen.findByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente' }), 'fern');
    await user.click(await within(dialog).findByRole('option', { name: /Fernández, Lucía/ }));
    await user.selectOptions(within(dialog).getByLabelText('Tipo de turno'), 'Control');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar a la lista' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Este paciente ya está esperando lo mismo',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('shows the limit of entries the server refuses with', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/waitlist': () => problemResponse(409, 'waitlist_entry_limit') });
    await user.click(await screen.findByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Paciente' }), 'fern');
    await user.click(await within(dialog).findByRole('option', { name: /Fernández, Lucía/ }));
    await user.selectOptions(within(dialog).getByLabelText('Tipo de turno'), 'Control');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar a la lista' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'ya tiene la cantidad máxima de esperas activas',
    );
  });
});

describe('looking after an entry', () => {
  it('pauses an active entry and resumes a paused one', async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    open(
      {
        [`POST /api/waitlist/${ids.entry}/pause`]: () => {
          posted.push('pause');
          return jsonResponse(entry({ status: 'paused' }));
        },
        [`POST /api/waitlist/${ids.second}/resume`]: () => {
          posted.push('resume');
          return jsonResponse(entry({ id: ids.second, status: 'active' }));
        },
      },
      { list: [entry(), entry({ id: ids.second, patientName: 'Mario Pérez', status: 'paused' })] },
    );

    const list = await screen.findByRole('list', { name: 'Esperas' });
    const [first, second] = within(list).getAllByRole('listitem');
    await user.click(within(first as HTMLElement).getByRole('button', { name: 'Pausar' }));
    await user.click(within(second as HTMLElement).getByRole('button', { name: 'Reanudar' }));

    await waitFor(() => {
      expect(posted).toEqual(['pause', 'resume']);
    });
  });

  it('closes an entry with the reason that was chosen', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        [`POST /api/waitlist/${ids.entry}/close`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(entry({ status: 'closed', closeReason: 'fulfilled' }));
        },
      },
      { list: [entry()] },
    );

    await user.click(await screen.findByRole('button', { name: 'Cerrar' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Cerrar la espera de Lucía Fernández',
    });
    expect(within(dialog).getByRole('radio', { name: 'Ya no necesita el turno' })).toBeChecked();
    await user.click(
      within(dialog).getByRole('radio', { name: 'Ya se le dio el turno que esperaba' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar la espera' }));

    await waitFor(() => {
      expect(body).toEqual({ reason: 'fulfilled' });
    });
  });

  it('changes the order of an entry, and says so in the list of options', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        [`POST /api/waitlist/${ids.entry}/priority`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(entry({ priority: 1 }));
        },
      },
      { list: [entry()] },
    );

    const select = await screen.findByLabelText('Orden');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Por orden de espera', 'Con prioridad', 'Urgente']);
    await user.selectOptions(select, 'Con prioridad');

    await waitFor(() => {
      expect(body).toEqual({ priority: 1 });
    });
  });

  it('edits when the patient can come and sends only a valid range', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        [`PATCH /api/waitlist/${ids.entry}`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(entry());
        },
      },
      {
        list: [
          entry({
            offersOptInAt: null,
            offersOptInSource: null,
            manualContactOnly: true,
            manualReason: 'no_offers_opt_in',
          }),
        ],
      },
    );

    await user.click(await screen.findByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Editar la espera de Lucía Fernández',
    });
    await user.click(within(dialog).getByRole('checkbox', { name: 'viernes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Tarde (12 a 18)' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: /El paciente aceptó recibir ofertas/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      expect(body).toEqual({
        professionalId: ids.professional,
        locationId: null,
        weekdays: [1, 4, 5],
        timeRanges: [
          { from: '08:00', to: '12:00' },
          { from: '12:00', to: '18:00' },
        ],
        earliestDate: null,
        latestDate: null,
        channels: ['email'],
        offersOptIn: true,
      });
    });
  });

  it('does not offer to record the agreement again once it was recorded', async () => {
    const user = userEvent.setup();
    open({}, { list: [entry()] });

    await user.click(await screen.findByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).queryByRole('checkbox', { name: /El paciente aceptó recibir ofertas/ }),
    ).toBeNull();
  });

  it('shows what the server said when a change is refused', async () => {
    const user = userEvent.setup();
    open(
      {
        [`POST /api/waitlist/${ids.entry}/pause`]: () =>
          problemResponse(409, 'waitlist_entry_closed'),
      },
      { list: [entry()] },
    );

    await user.click(await screen.findByRole('button', { name: 'Pausar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Esta espera ya está cerrada y no se puede modificar.',
    );
  });
});

describe('an organization that is read-only', () => {
  it('lets the list be read and nothing be changed', async () => {
    open({}, { list: [entry()], readOnly: true });

    await screen.findByRole('list', { name: 'Esperas' });
    expect(screen.getByRole('button', { name: 'Agregar a la lista' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cerrar' })).toBeDisabled();
    expect(screen.getByLabelText('Orden')).toBeDisabled();
  });
});

describe('accessibility', () => {
  it('has no violations with entries, slots to call and a note about silent patients', async () => {
    const app = open(
      {},
      {
        list: [
          entry({ manualContactOnly: true, manualReason: 'no_offers_opt_in' }),
          entry({
            id: ids.second,
            patientName: 'Mario Pérez',
            unresponsive: true,
            consecutiveExpired: 3,
          }),
        ],
        calls: calls({
          items: [callItem()],
          unresponsive: [entry({ unresponsive: true, consecutiveExpired: 3 })],
        }),
      },
    );

    await screen.findByRole('list', { name: 'Esperas' });
    await screen.findByRole('region', { name: 'Turnos para ofrecer por teléfono' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('has no violations in the dialog to add a patient, with its fields', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Agregar a la lista' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Otra franja' }));

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});
