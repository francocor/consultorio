import type { AppointmentStatus, CalendarEntryDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';
import { resetViewportAfterEach, setViewport } from '../../shared/test/viewport.js';
import { entry, IDS, LOCATIONS, PROFESSIONALS } from '../calendar/fixtures.js';

resetViewportAfterEach();

const RECEPTION = meFor(['reception'], {
  user: { id: IDS.receptionMembership, email: 'recepcion@demo.invalid' },
});

let counter = 0;
function visit(
  status: AppointmentStatus,
  startsAt: string,
  name: string,
  extra: Partial<CalendarEntryDto> = {},
): CalendarEntryDto {
  counter += 1;
  const id = `0190a000-0000-7000-8000-00000000e${String(counter).padStart(3, '0')}`;
  return entry({
    id,
    status,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
    patientName: name,
    version: 5,
    ...extra,
  });
}

const DAY = [
  visit('scheduled', '2026-10-17T13:00:00.000Z', 'Gómez, Valentina'),
  visit('confirmed', '2026-10-17T13:30:00.000Z', 'Ríos, Tomás', { professionalId: IDS.beto }),
  visit('scheduled', '2026-10-17T14:00:00.000Z', 'Sosa, Marta', { identityConfirmed: false }),
  visit('checked_in', '2026-10-17T12:30:00.000Z', 'Pérez, Julián'),
  visit('in_progress', '2026-10-17T12:00:00.000Z', 'Núñez, Olga'),
  visit('cancelled', '2026-10-17T15:00:00.000Z', 'Cancelada, Fabiana'),
];

function open(routes: Record<string, FetchHandler | Response> = {}, me = RECEPTION) {
  const feedUrls: string[] = [];
  const app = renderApp({
    me,
    path: '/check-in',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/appointments': (url) => {
        feedUrls.push(url);
        return jsonResponse({ appointments: DAY, blocks: [], holidays: [] });
      },
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      ...routes,
    },
  });
  return { ...app, feedUrls };
}

function withoutNames(item: CalendarEntryDto) {
  const names = new Set(['patientName', 'typeName', 'typeColor']);
  return Object.fromEntries(Object.entries(item).filter(([key]) => !names.has(key)));
}

describe('the front desk', () => {
  it('lists who is still to arrive, in order, with the professional and the time', async () => {
    setViewport(1280);
    open();

    const arriving = await screen.findByRole('region', { name: 'Por llegar' });
    const rows = within(arriving).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Gómez, Valentina');
    expect(rows[0]).toHaveTextContent('Dra. Ana Pérez');
    expect(rows[0]).toHaveTextContent('10:00');
    expect(rows[1]).toHaveTextContent('Dr. Beto Ruiz');
  });

  it('shows who is waiting and who is in a consultation, and leaves out the cancelled', async () => {
    setViewport(1280);
    open();

    expect(
      within(await screen.findByRole('region', { name: 'En sala' })).getByText('Pérez, Julián'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'En consulta' })).getByText('Núñez, Olga'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Cancelada, Fabiana')).not.toBeInTheDocument();
  });

  it('registers the arrival in one click when the identity is already confirmed', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      [`POST /api/appointments/${DAY[0]?.id ?? ''}/check-in`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          withoutNames({ ...(DAY[0] as CalendarEntryDto), status: 'checked_in', version: 6 }),
        );
      },
    });

    const row = (await screen.findByText('Gómez, Valentina')).closest('li');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Registrar llegada' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 5 }]);
    });
  });

  it('opens the arrival step instead when the identity still has to be confirmed', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const sosa = DAY[2] as CalendarEntryDto;
    open({
      [`GET /api/appointments/${sosa.id}`]: () => jsonResponse(sosa),
      [`GET /api/appointments/${sosa.id}/history`]: () =>
        jsonResponse({ appointmentId: sosa.id, rescheduledCount: 0, events: [] }),
    });

    const row = (await screen.findByText('Sosa, Marta')).closest('li');
    expect(within(row as HTMLElement).getByText('Identidad sin confirmar')).toBeInTheDocument();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Registrar llegada' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sosa, Marta' });
    expect(
      await within(dialog).findByRole('group', { name: 'Llegada del paciente' }),
    ).toBeInTheDocument();
  });

  it('finds a patient by typing part of the name', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    open();
    await screen.findByText('Gómez, Valentina');

    await user.type(
      screen.getByRole('searchbox', { name: 'Buscar entre los turnos de hoy' }),
      'rios',
    );

    expect(screen.getByText('Ríos, Tomás')).toBeInTheDocument();
    expect(screen.queryByText('Gómez, Valentina')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('Ningún turno coincide con la búsqueda.')).toBeInTheDocument();
  });

  it('asks for the local day, for everybody the person may see', async () => {
    setViewport(1280);
    const app = open();
    await screen.findByText('Gómez, Valentina');

    const query = new URL(app.feedUrls[0] ?? '', 'http://x').searchParams;
    expect(query.has('professionalIds')).toBe(false);
    expect(
      new Date(query.get('to') ?? '').getTime() - new Date(query.get('from') ?? '').getTime(),
    ).toBe(24 * 3_600_000);
  });

  it('is accessible on a phone and on a desktop', async () => {
    setViewport(360);
    const phone = open();
    await screen.findByText('Gómez, Valentina');
    expect(await a11yViolations(phone.container)).toEqual([]);
    phone.unmount();

    setViewport(1280);
    const desktop = open();
    await screen.findByText('Gómez, Valentina');
    expect(await a11yViolations(desktop.container)).toEqual([]);
  });
});
