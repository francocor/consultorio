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

const ANA = meFor(['professional'], {
  user: { id: IDS.anaMembership, email: 'cardiologia@demo.invalid' },
});

let counter = 0;
function visit(
  status: AppointmentStatus,
  startsAt: string,
  name: string,
  version = 1,
): CalendarEntryDto {
  counter += 1;
  const id = `0190a000-0000-7000-8000-00000000d${String(counter).padStart(3, '0')}`;
  return entry({
    id,
    status,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
    patientName: name,
    version,
  });
}

const DAY = [
  visit('attended', '2026-10-17T12:00:00.000Z', 'Atendida, Ana'),
  visit('in_progress', '2026-10-17T13:00:00.000Z', 'Consulta, Carlos', 4),
  visit('checked_in', '2026-10-17T14:00:00.000Z', 'Espera, Beatriz', 3),
  visit('checked_in', '2026-10-17T14:30:00.000Z', 'Espera, Daniel', 2),
  visit('confirmed', '2026-10-17T16:00:00.000Z', 'Próxima, Elena', 1),
  visit('cancelled', '2026-10-17T17:00:00.000Z', 'Cancelada, Fabiana', 1),
];

/** What the API answers with: the appointment, without the names the feed adds. */
function withoutNames(item: CalendarEntryDto) {
  const names = new Set(['patientName', 'typeName', 'typeColor']);
  return Object.fromEntries(Object.entries(item).filter(([key]) => !names.has(key)));
}

interface Open {
  me?: ReturnType<typeof meFor>;
  routes?: Record<string, FetchHandler | Response>;
  items?: CalendarEntryDto[];
}

function open(options: Open = {}) {
  const feedUrls: string[] = [];
  const app = renderApp({
    me: options.me ?? ANA,
    path: '/today',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/appointments': (url) => {
        feedUrls.push(url);
        return jsonResponse({ appointments: options.items ?? DAY, blocks: [], holidays: [] });
      },
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      ...options.routes,
    },
  });
  return { ...app, feedUrls };
}

describe("a professional's day", () => {
  it('shows who is next and a single button to call them in', async () => {
    setViewport(360);
    open();

    const next = await screen.findByRole('region', { name: 'Siguiente paciente' });
    expect(within(next).getByText('Espera, Beatriz')).toBeInTheDocument();
    expect(within(next).getByRole('button', { name: 'Iniciar consulta' })).toBeInTheDocument();
  });

  it('starts the consultation with the version of the appointment', async () => {
    setViewport(360);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      routes: {
        [`POST /api/appointments/${DAY[2]?.id ?? ''}/start`]: (_url, init) => {
          bodies.push(jsonBody(init));
          const appointment = withoutNames({
            ...(DAY[2] as CalendarEntryDto),
            status: 'in_progress',
            version: 4,
          });
          return jsonResponse(appointment);
        },
      },
    });

    await user.click(
      within(await screen.findByRole('region', { name: 'Siguiente paciente' })).getByRole(
        'button',
        { name: 'Iniciar consulta' },
      ),
    );

    await waitFor(() => {
      expect(bodies).toEqual([{ expectedVersion: 3 }]);
    });
  });

  it('shows the consultation in progress with a button to finish it', async () => {
    setViewport(360);
    open();

    const running = await screen.findByRole('region', { name: 'En consulta' });

    expect(within(running).getByText('Consulta, Carlos')).toBeInTheDocument();
    expect(within(running).getByRole('button', { name: 'Finalizar consulta' })).toBeInTheDocument();
  });

  it('lists the rest of the day by what is left to do, without the cancelled', async () => {
    setViewport(360);
    open();

    const waiting = await screen.findByRole('region', { name: 'En sala' });
    expect(within(waiting).getAllByRole('listitem')).toHaveLength(2);
    const upcoming = screen.getByRole('region', { name: 'Por llegar' });
    expect(within(upcoming).getByText('Próxima, Elena')).toBeInTheDocument();
    expect(screen.queryByText('Cancelada, Fabiana')).not.toBeInTheDocument();
    expect(screen.getByText('Atendida, Ana')).toBeInTheDocument();
  });

  it('counts the day in words at the top', async () => {
    setViewport(360);
    open();

    const summary = await screen.findByRole('list', { name: 'Resumen del día' });
    expect(summary).toHaveTextContent('En sala: 2');
    expect(summary).toHaveTextContent('Por llegar: 1');
    expect(summary).toHaveTextContent('Terminados: 1');
  });

  it('asks only for its own professional and for today in the location zone', async () => {
    setViewport(360);
    const app = open();
    await screen.findByRole('region', { name: 'Siguiente paciente' });

    const query = new URL(app.feedUrls[0] ?? '', 'http://x').searchParams;
    expect(query.get('professionalIds')).toBe(IDS.ana);
    // A whole local day: 24 hours in Buenos Aires.
    expect(
      new Date(query.get('to') ?? '').getTime() - new Date(query.get('from') ?? '').getTime(),
    ).toBe(24 * 3_600_000);
  });

  it('opens the appointment with its actions when a row is chosen', async () => {
    setViewport(360);
    const user = userEvent.setup();
    open({
      routes: {
        [`GET /api/appointments/${DAY[4]?.id ?? ''}`]: () => jsonResponse(DAY[4]),
        [`GET /api/appointments/${DAY[4]?.id ?? ''}/history`]: () =>
          jsonResponse({ appointmentId: DAY[4]?.id, rescheduledCount: 0, events: [] }),
      },
    });

    await user.click(await screen.findByRole('button', { name: /Próxima, Elena/ }));

    expect(await screen.findByRole('dialog', { name: 'Próxima, Elena' })).toBeInTheDocument();
  });

  it('is accessible on a phone', async () => {
    setViewport(360);
    const { container } = open();
    await screen.findByRole('region', { name: 'Siguiente paciente' });

    expect(await a11yViolations(container)).toEqual([]);
  });

  it('says plainly when the day is empty', async () => {
    setViewport(360);
    open({ items: [] });

    expect(await screen.findByText('No hay turnos para hoy.')).toBeInTheDocument();
  });

  it('is for professionals: somebody else is told so, and nothing is requested', async () => {
    setViewport(360);
    const app = open({ me: meFor(['reception']) });

    expect(
      await screen.findByText('Esta vista es para profesionales de la salud.'),
    ).toBeInTheDocument();
    expect(app.feedUrls).toEqual([]);
  });
});

describe('the consultation starts from the appointment (D20)', () => {
  it('links the consultation in progress to a new encounter tied to the appointment', async () => {
    setViewport(360);
    open();

    const running = await screen.findByRole('region', { name: 'En consulta' });

    const link = within(running).getByRole('link', { name: 'Iniciar consulta' });
    const target = new URL(link.getAttribute('href') ?? '', 'http://app.test');
    expect(target.pathname).toBe('/encounters/new');
    expect(target.searchParams.get('appointmentId')).toBe(DAY[1]?.id);
    expect(target.searchParams.get('patientId')).toBe(DAY[1]?.patientId);
  });

  it('opens the new encounter once the patient is called in', async () => {
    setViewport(360);
    const user = userEvent.setup();
    const app = open({
      routes: {
        [`POST /api/appointments/${DAY[2]?.id ?? ''}/start`]: () =>
          jsonResponse(
            withoutNames({ ...(DAY[2] as CalendarEntryDto), status: 'in_progress', version: 4 }),
          ),
        'GET /api/clinical/templates': () => jsonResponse({ templates: [] }),
        [`GET /api/patients/${DAY[2]?.patientId ?? ''}`]: () => new Response('{}', { status: 404 }),
      },
    });

    await user.click(
      within(await screen.findByRole('region', { name: 'Siguiente paciente' })).getByRole(
        'button',
        { name: 'Iniciar consulta' },
      ),
    );

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/encounters/new');
    });
    expect(app.router.state.location.search).toMatchObject({
      appointmentId: DAY[2]?.id,
      patientId: DAY[2]?.patientId,
    });
  });
});
