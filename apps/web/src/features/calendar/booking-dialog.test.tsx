import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import {
  fakeFetch,
  jsonBody,
  jsonResponse,
  renderWithApp,
  type FetchHandler,
} from '../../shared/test/render.js';
import { SUMMARIES } from '../patients/fixtures.js';

import { BookingDialog, type BookingDialogProps } from './components/BookingDialog.js';
import type { SchedulingProfessional } from './containers/use-scheduling-people.js';
import { IDS, LOCATIONS, TYPES } from './fixtures.js';

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

const slot = (isoStart: string, minutes = 45) => ({
  startsAt: isoStart,
  endsAt: new Date(new Date(isoStart).getTime() + minutes * 60_000).toISOString(),
  locationId: IDS.central,
  date: '2026-10-17',
});

// 10:00, 10:30 and 11:00 in Buenos Aires.
const SLOTS = [
  slot('2026-10-17T13:00:00.000Z'),
  slot('2026-10-17T13:30:00.000Z'),
  slot('2026-10-17T14:00:00.000Z'),
];

const BOOKED = {
  id: IDS.appointmentGomez,
  patientId: IDS.patientGomez,
  professionalId: IDS.ana,
  locationId: IDS.central,
  appointmentTypeId: IDS.first,
  startsAt: '2026-10-17T13:00:00.000Z',
  endsAt: '2026-10-17T13:45:00.000Z',
  bufferMinutes: 0,
  status: 'scheduled',
  source: 'staff',
  bookedBy: IDS.receptionMembership,
  identityConfirmed: true,
  identityConfirmation: null,
  outOfHours: false,
  seriesId: null,
  seriesIndex: null,
  version: 1,
};

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'req-1',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

interface Mount {
  props?: Partial<BookingDialogProps>;
  routes?: Record<string, FetchHandler | Response>;
  slots?: typeof SLOTS;
}

function mount({ props = {}, routes = {}, slots = SLOTS }: Mount = {}) {
  const availabilityUrls: string[] = [];
  const bookings: unknown[] = [];
  const onBooked = vi.fn();
  const onOpenChange = vi.fn();
  const app = renderWithApp(
    <BookingDialog
      open
      onOpenChange={onOpenChange}
      professionals={[ANA, BETO]}
      locations={LOCATIONS}
      canOverrideHours
      onBooked={onBooked}
      {...props}
    />,
    {
      fetch: fakeFetch({
        'GET /api/appointment-types': () => jsonResponse({ types: TYPES }),
        'GET /api/availability': (url) => {
          availabilityUrls.push(url);
          return jsonResponse({
            professionalId: IDS.ana,
            typeId: IDS.first,
            slots,
            closedDays: [],
          });
        },
        'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
        'POST /api/appointments': (_url, init) => {
          bookings.push(jsonBody(init));
          return jsonResponse(BOOKED, 201);
        },
        ...routes,
      }),
    },
  );
  return { ...app, availabilityUrls, bookings, onBooked, onOpenChange };
}

const FROM_GRID = {
  initial: { professionalId: IDS.ana, start: new Date('2026-10-17T13:00:00.000Z') },
};

async function pickPatient(user: ReturnType<typeof userEvent.setup>, name = /Gómez, Valentina/) {
  await user.type(screen.getByRole('combobox', { name: 'Paciente' }), 'gom');
  await user.click(await screen.findByRole('option', { name }));
}

describe('booking from a time chosen on the grid', () => {
  it('needs only the patient: the professional, the time and the type are already there', async () => {
    const user = userEvent.setup();
    const app = mount({ props: FROM_GRID });

    expect(
      await screen.findByText('Horario elegido: sábado 17 de octubre, 10:00'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Profesional')).toHaveValue(IDS.ana);
    expect(screen.getByRole('button', { name: 'Dar turno' })).toBeDisabled();

    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    await waitFor(() => {
      expect(app.bookings).toHaveLength(1);
    });
    expect(app.bookings[0]).toEqual({
      patientId: SUMMARIES[0]?.id,
      professionalId: IDS.ana,
      locationId: IDS.central,
      appointmentTypeId: IDS.first,
      startsAt: '2026-10-17T13:00:00.000Z',
    });
    await waitFor(() => {
      expect(app.onBooked).toHaveBeenCalledWith(
        expect.objectContaining({ id: IDS.appointmentGomez }),
      );
    });
    expect(await screen.findByText(/Turno asignado a Gómez, Valentina el/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('asks for the free times of that professional, type and day in the location', async () => {
    const app = mount({ props: FROM_GRID });
    await waitFor(() => {
      expect(app.availabilityUrls).not.toHaveLength(0);
    });

    const query = new URL(app.availabilityUrls[0] ?? '', 'http://x').searchParams;
    expect(query.get('professionalId')).toBe(IDS.ana);
    expect(query.get('typeId')).toBe(IDS.first);
    expect(query.get('from')).toBe('2026-10-17');
    expect(query.get('to')).toBe('2026-10-17');
  });
});

describe('booking from the day on screen', () => {
  it('opens on that day and for that professional, ready to pick one of the free times', async () => {
    const app = mount({
      props: { initial: { professionalId: IDS.beto, date: '2026-10-20' } },
    });

    expect(await screen.findByLabelText('Fecha')).toHaveValue('2026-10-20');
    expect(screen.getByLabelText('Profesional')).toHaveValue(IDS.beto);
    await waitFor(() => {
      expect(app.availabilityUrls).not.toHaveLength(0);
    });
    const query = new URL(app.availabilityUrls[0] ?? '', 'http://x').searchParams;
    expect(query.get('professionalId')).toBe(IDS.beto);
    expect(query.get('from')).toBe('2026-10-20');
    // Nothing is chosen yet: the person still has to pick a time.
    expect(screen.queryByText(/Horario elegido/)).not.toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Horarios disponibles' })).toBeInTheDocument();
  });
});

describe('booking from scratch', () => {
  it('chooses the professional, the day, a free time and the patient', async () => {
    const user = userEvent.setup();
    const app = mount();

    await user.selectOptions(screen.getByLabelText('Profesional'), IDS.ana);
    fireEvent.change(screen.getByLabelText('Fecha'), { target: { value: '2026-10-17' } });
    const grid = await screen.findByRole('group', { name: 'Horarios disponibles' });
    await user.click(within(grid).getByRole('button', { name: '10:30' }));
    expect(screen.getByText('Horario elegido: sábado 17 de octubre, 10:30')).toBeInTheDocument();
    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    await waitFor(() => {
      expect(app.bookings).toHaveLength(1);
    });
    expect(app.bookings[0]).toMatchObject({
      professionalId: IDS.ana,
      startsAt: '2026-10-17T13:30:00.000Z',
    });
  });

  it('offers only the types the professional attends, and asks for the free times of the one chosen', async () => {
    const user = userEvent.setup();
    const onlyBeto = TYPES.map((type) =>
      type.id === IDS.control ? { ...type, professionalIds: [IDS.beto] } : type,
    );
    const app = mount({
      props: { initial: { professionalId: IDS.ana, start: new Date('2026-10-17T13:00:00.000Z') } },
      routes: { 'GET /api/appointment-types': () => jsonResponse({ types: onlyBeto }) },
    });

    const select = await screen.findByLabelText('Tipo de turno');
    await waitFor(() => {
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Primera consulta (45 min)']);
    });

    await user.selectOptions(screen.getByLabelText('Profesional'), IDS.beto);
    await waitFor(() => {
      expect(within(screen.getByLabelText('Tipo de turno')).getAllByRole('option')).toHaveLength(2);
    });
    await user.selectOptions(screen.getByLabelText('Tipo de turno'), IDS.control);

    await waitFor(() => {
      const last = new URL(app.availabilityUrls.at(-1) ?? '', 'http://x').searchParams;
      expect(last.get('typeId')).toBe(IDS.control);
      expect(last.get('professionalId')).toBe(IDS.beto);
    });
  });

  it('says so when the day has no free times', async () => {
    const user = userEvent.setup();
    mount({ slots: [] });

    await user.selectOptions(screen.getByLabelText('Profesional'), IDS.ana);
    fireEvent.change(screen.getByLabelText('Fecha'), { target: { value: '2026-10-17' } });

    expect(
      await screen.findByText('No hay horarios disponibles ese día. Pruebe con otra fecha.'),
    ).toBeInTheDocument();
  });
});

describe('when the time was taken meanwhile (409 slot_taken)', () => {
  const conflict = {
    conflict: { startsAt: '2026-10-17T13:00:00.000Z', endsAt: '2026-10-17T13:45:00.000Z' },
    nextSlots: [
      { startsAt: '2026-10-17T14:00:00.000Z', endsAt: '2026-10-17T14:45:00.000Z' },
      { startsAt: '2026-10-17T14:30:00.000Z', endsAt: '2026-10-17T15:15:00.000Z' },
    ],
  };

  it('shows the next free times and books the one chosen with a single click', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const app = mount({
      props: FROM_GRID,
      routes: {
        'POST /api/appointments': (_url, init) => {
          app.bookings.push(jsonBody(init));
          attempt += 1;
          return attempt === 1 ? problem(409, 'slot_taken', conflict) : jsonResponse(BOOKED, 201);
        },
      },
    });
    await screen.findByText(/Horario elegido/);
    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Ese horario ya no está disponible')).toBeInTheDocument();
    const next = within(alert).getAllByRole('button');
    expect(next.map((button) => button.textContent)).toEqual(['11:00', '11:30']);
    // The dialog stays open with everything already filled in.
    expect(screen.getByRole('button', { name: 'Dar turno' })).toBeEnabled();

    await user.click(next[0] as HTMLElement);
    expect(screen.getByText('Horario elegido: sábado 17 de octubre, 11:00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    await waitFor(() => {
      expect(app.bookings).toHaveLength(2);
    });
    expect(app.bookings[1]).toMatchObject({ startsAt: '2026-10-17T14:00:00.000Z' });
    expect(app.onBooked).toHaveBeenCalled();
  });

  it('still explains itself when the answer carries no next times', async () => {
    const user = userEvent.setup();
    mount({
      props: FROM_GRID,
      routes: { 'POST /api/appointments': () => problem(409, 'slot_taken') },
    });
    await screen.findByText(/Horario elegido/);
    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Ese horario ya no está disponible. Elija otro.'),
    ).toBeInTheDocument();
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('a booking the API refuses for lack of permission (403)', () => {
  it('says so and keeps the dialog open, as for a time that needs the hold override', async () => {
    const user = userEvent.setup();
    const app = mount({
      props: FROM_GRID,
      routes: { 'POST /api/appointments': () => problem(403, 'forbidden') },
    });
    await screen.findByText(/Horario elegido/);
    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No tiene permiso para realizar esta acción.');
    expect(app.onBooked).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Nuevo turno' })).toBeInTheDocument();
  });
});

describe('a time outside the working hours', () => {
  const OUTSIDE = {
    initial: { professionalId: IDS.ana, start: new Date('2026-10-17T09:00:00.000Z') },
  };

  it('asks for a reason, keeps the button off until there is one, and sends it', async () => {
    const user = userEvent.setup();
    const app = mount({ props: OUTSIDE });
    expect(
      await screen.findByText('Ese horario está fuera de la atención del profesional.'),
    ).toBeInTheDocument();
    await pickPatient(user);
    expect(screen.getByRole('button', { name: 'Dar turno' })).toBeDisabled();

    await user.type(screen.getByLabelText('Motivo del turno fuera de horario'), 'Control urgente');
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    await waitFor(() => {
      expect(app.bookings).toHaveLength(1);
    });
    expect(app.bookings[0]).toMatchObject({
      startsAt: '2026-10-17T09:00:00.000Z',
      overrideHours: { reason: 'Control urgente' },
    });
  });

  it('does not offer the exception to somebody without the permission', async () => {
    const user = userEvent.setup();
    mount({ props: { ...OUTSIDE, canOverrideHours: false } });

    expect(
      await screen.findByText(/No tiene permiso para dar turnos fuera de horario/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Motivo del turno fuera de horario')).not.toBeInTheDocument();
    await pickPatient(user);
    expect(screen.getByRole('button', { name: 'Dar turno' })).toBeDisabled();
  });
});

describe('other refusals and accessibility', () => {
  it('shows what the server refused, in words', async () => {
    const user = userEvent.setup();
    mount({
      props: FROM_GRID,
      routes: {
        'POST /api/appointments': () =>
          problem(400, 'validation_failed', {
            errors: [{ path: 'startsAt', i18nKey: 'scheduling.booking.in_past' }],
          }),
      },
    });
    await screen.findByText(/Horario elegido/);
    await pickPatient(user);
    await user.click(screen.getByRole('button', { name: 'Dar turno' }));

    expect(
      await screen.findByText(
        'Ese horario ya pasó. Solo quien tiene permiso para registrar turnos pasados puede cargarlo.',
      ),
    ).toBeInTheDocument();
  });

  it('is accessible, with a patient chosen and with the conflict shown', async () => {
    const user = userEvent.setup();
    mount({
      props: FROM_GRID,
      routes: {
        'POST /api/appointments': () =>
          problem(409, 'slot_taken', {
            conflict: { startsAt: '2026-10-17T13:00:00.000Z', endsAt: '2026-10-17T13:45:00.000Z' },
            nextSlots: [
              { startsAt: '2026-10-17T14:00:00.000Z', endsAt: '2026-10-17T14:45:00.000Z' },
            ],
          }),
      },
    });
    await screen.findByText(/Horario elegido/);
    await pickPatient(user);
    expect(await a11yViolations(screen.getByRole('dialog'))).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Dar turno' }));
    await screen.findByRole('alert');
    expect(await a11yViolations(screen.getByRole('dialog'))).toEqual([]);
  });
});
