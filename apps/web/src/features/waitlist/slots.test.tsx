import type { CalendarEntryDto, WaitlistEntryDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderInRouter } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../shared/test/render.js';

import { CloseEntryPrompt } from './components/CloseEntryPrompt.js';
import slots from './slots.js';

const ids = {
  entry: '0190a000-0000-7000-8000-0000000000a1',
  appointment: '0190a000-0000-7000-8000-0000000000a2',
  patient: '0190a000-0000-7000-8000-0000000000b1',
  type: '0190a000-0000-7000-8000-0000000000c1',
  professional: '0190a000-0000-7000-8000-0000000000d1',
  other: '0190a000-0000-7000-8000-0000000000d2',
  location: '0190a000-0000-7000-8000-0000000000e1',
  elsewhere: '0190a000-0000-7000-8000-0000000000e2',
};

const appointment = (overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto => ({
  id: ids.appointment,
  patientId: ids.patient,
  professionalId: ids.professional,
  locationId: ids.location,
  appointmentTypeId: ids.type,
  startsAt: '2031-05-12T13:00:00.000Z',
  endsAt: '2031-05-12T13:30:00.000Z',
  bufferMinutes: 0,
  status: 'scheduled',
  source: 'staff',
  bookedBy: null,
  identityConfirmed: true,
  identityConfirmation: null,
  outOfHours: false,
  seriesId: null,
  seriesIndex: null,
  version: 1,
  patientName: 'Lucía Fernández',
  typeName: 'Control',
  typeColor: null,
  mode: 'in_person',
  ...overrides,
});

const entry = (overrides: Partial<WaitlistEntryDto> = {}): WaitlistEntryDto => ({
  id: ids.entry,
  patientId: ids.patient,
  patientName: 'Lucía Fernández',
  appointmentTypeId: ids.type,
  appointmentTypeName: 'Control',
  professionalId: null,
  professionalName: null,
  locationId: null,
  locationName: null,
  weekdays: [],
  timeRanges: [],
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

type Handler = (url: string, init: RequestInit) => Response;

/** Lets the screen finish what it was going to do (a request in flight, a render). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  entries: WaitlistEntryDto[],
  props: Partial<{ appointment: CalendarEntryDto; readOnly: boolean }> = {},
  routes: Record<string, Handler | Response> = {},
) {
  const requests: string[] = [];
  const app = renderInRouter(
    <CloseEntryPrompt
      appointment={props.appointment ?? appointment()}
      readOnly={props.readOnly ?? false}
    />,
    {
      me: meFor(['reception']),
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        'GET /api/waitlist': (url) => {
          requests.push(url);
          return jsonResponse({ entries });
        },
        ...routes,
      },
    },
  );
  missing = app.missingKeys;
  return { ...app, listed: requests };
}

describe('the suggestion to close the entry of a patient who was just booked', () => {
  it('asks for the entries of that patient, type and professional, and suggests closing the one that fits', async () => {
    const app = open([entry()]);

    expect(await screen.findByRole('heading', { name: 'Lista de espera' })).toBeVisible();
    expect(
      screen.getByText(/Este paciente espera un turno de Control con cualquier profesional/),
    ).toBeVisible();
    const url = new URL(app.listed[0] ?? '', 'http://localhost');
    expect(url.searchParams.get('patientId')).toBe(ids.patient);
    expect(url.searchParams.get('appointmentTypeId')).toBe(ids.type);
    expect(url.searchParams.get('professionalId')).toBe(ids.professional);
  });

  it('names the professional the entry waits for', async () => {
    open([entry({ professionalId: ids.professional, professionalName: 'Dra. Ríos' })]);

    expect(await screen.findByText(/con Dra\. Ríos/)).toBeVisible();
  });

  it('does nothing until a person confirms: it closes the entry as fulfilled only after the dialog', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      [entry()],
      {},
      {
        [`POST /api/waitlist/${ids.entry}/close`]: (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(entry({ status: 'closed', closeReason: 'fulfilled' }));
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: 'Cerrar la espera' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Cerrar la espera de Lucía Fernández',
    });
    expect(body).toBeUndefined();
    expect(
      within(dialog).getByRole('radio', { name: 'Ya se le dio el turno que esperaba' }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar la espera' }));

    await waitFor(() => {
      expect(body).toEqual({ reason: 'fulfilled' });
    });
  });

  it('can be left open: the suggestion goes away and the entry is untouched', async () => {
    const user = userEvent.setup();
    open([entry()]);

    await user.click(await screen.findByRole('button', { name: 'Dejarla abierta' }));

    expect(screen.queryByRole('heading', { name: 'Lista de espera' })).toBeNull();
  });

  it('suggests nothing for an entry that waits for another professional or another place', async () => {
    const app = open([
      entry({
        id: '0190a000-0000-7000-8000-0000000000a3',
        professionalId: ids.other,
        professionalName: 'Dr. Paz',
      }),
      entry({
        id: '0190a000-0000-7000-8000-0000000000a4',
        locationId: ids.elsewhere,
        locationName: 'Norte',
      }),
    ]);

    await waitFor(() => {
      expect(app.listed).toHaveLength(1);
    });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Lista de espera' })).toBeNull();
  });

  it('suggests nothing when the patient is not on the list', async () => {
    const app = open([]);

    await waitFor(() => {
      expect(app.listed).toHaveLength(1);
    });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Lista de espera' })).toBeNull();
  });

  it('suggests nothing for an appointment that is cancelled, and asks the server nothing', async () => {
    const app = open([entry()], { appointment: appointment({ status: 'cancelled' }) });

    await settle();
    expect(screen.queryByRole('heading', { name: 'Lista de espera' })).toBeNull();
    expect(app.listed).toEqual([]);
  });

  it('suggests nothing while the organization is read-only', async () => {
    const app = open([entry()], { readOnly: true });

    await settle();
    expect(screen.queryByRole('heading', { name: 'Lista de espera' })).toBeNull();
    expect(app.listed).toEqual([]);
  });

  it('has no accessibility violations', async () => {
    const app = open([entry()]);
    await screen.findByRole('heading', { name: 'Lista de espera' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('what the waitlist mounts in other screens', () => {
  it('puts the suggestion in the appointment drawer, for whoever manages the waitlist', () => {
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slot: 'appointment-drawer',
      id: 'waitlist.close-prompt',
      anyOf: ['waitlist.manage'],
    });
  });
});
