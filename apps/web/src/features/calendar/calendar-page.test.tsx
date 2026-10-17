import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';
import { resetViewportAfterEach, setViewport } from '../../shared/test/viewport.js';

import { FEED_ENTRIES, IDS, LOCATIONS, PROFESSIONALS, TYPES } from './fixtures.js';

resetViewportAfterEach();

const RECEPTION = meFor(['reception'], {
  user: { id: IDS.receptionMembership, email: 'recepcion@demo.invalid' },
});
const ANA_USER = meFor(['professional'], {
  user: { id: IDS.anaMembership, email: 'cardiologia@demo.invalid' },
});

interface OpenOptions {
  me?: ReturnType<typeof meFor>;
  path?: string;
  feed?: () => Response;
  routes?: Record<string, FetchHandler | Response>;
}

function open(options: OpenOptions = {}) {
  const feedUrls: string[] = [];
  const app = renderApp({
    me: options.me ?? RECEPTION,
    path: options.path ?? '/calendar?date=2026-10-17',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/appointments': (url) => {
        feedUrls.push(url);
        return (
          options.feed?.() ??
          jsonResponse({
            appointments: FEED_ENTRIES,
            blocks: [
              {
                id: '0190a000-0000-7000-8000-0000000000b1',
                professionalId: IDS.ana,
                locationId: null,
                startsAt: '2026-10-17T15:00:00.000Z',
                endsAt: '2026-10-17T15:30:00.000Z',
                reason: 'Congreso',
                seriesId: null,
              },
            ],
            holidays: [
              {
                day: '2026-10-17',
                name: 'Día de la Lealtad',
                source: 'national',
                locationId: null,
                dayOffId: null,
              },
            ],
          })
        );
      },
      'GET /api/staff': () => jsonResponse({ staff: PROFESSIONALS }),
      'GET /api/locations': () => jsonResponse({ locations: LOCATIONS }),
      'GET /api/appointment-types': () => jsonResponse({ types: TYPES }),
      'GET /api/availability': () =>
        jsonResponse({ professionalId: IDS.ana, typeId: IDS.first, slots: [], closedDays: [] }),
      ...options.routes,
    },
  });
  return { ...app, feedUrls };
}

const params = (url: string | undefined) => new URL(url ?? '', 'http://x').searchParams;

describe('the agenda on a wide screen', () => {
  it('shows the day with a column per professional and every appointment in its column', async () => {
    setViewport(1280);
    const app = open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Agenda' })).toBeInTheDocument();
    const ana = await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });
    const beto = screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });
    expect(within(ana).getByRole('button', { name: /Gómez, Valentina/ })).toBeInTheDocument();
    expect(within(beto).getByRole('button', { name: /Ríos, Tomás/ })).toBeInTheDocument();
    expect(within(beto).queryByRole('button', { name: /Gómez/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('sábado 17 de octubre', { selector: '[aria-live]' }),
    ).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('asks for the local day of the location', async () => {
    setViewport(1280);
    const { feedUrls } = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    const query = params(feedUrls[0]);
    expect(query.get('from')).toBe('2026-10-17T03:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-18T03:00:00.000Z');
  });

  it('shows a block and a holiday as words, not only as a tint', async () => {
    setViewport(1280);
    open();

    expect(await screen.findByText('Bloqueado: Congreso')).toBeInTheDocument();
    expect(screen.getAllByText('Cerrado: Día de la Lealtad').length).toBeGreaterThan(0);
  });

  it('hides cancelled appointments until asked, then shows them struck through in words', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });
    expect(screen.queryByRole('button', { name: /Sosa, Marta/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Mostrar turnos cancelados' }));

    expect(
      await screen.findByRole('button', { name: /Sosa, Marta.*Cancelado/ }),
    ).toBeInTheDocument();
  });

  it('lists the eight statuses in words in the legend', async () => {
    setViewport(1280);
    open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    const legend = screen.getByRole('list', { name: 'Referencias de estado' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Pendiente de aprobación',
      'Programado',
      'Confirmado',
      'En sala',
      'En consulta',
      'Atendido',
      'Ausente',
      'Cancelado',
    ]);
  });

  it('is accessible', async () => {
    setViewport(1280);
    const { container } = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('moving through time and filtering', () => {
  it('goes to the next day and back to today', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const { feedUrls } = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Día siguiente' }));

    await waitFor(() => {
      expect(params(feedUrls.at(-1)).get('from')).toBe('2026-10-18T03:00:00.000Z');
    });
    expect(
      screen.getByText('domingo 18 de octubre', { selector: '[aria-live]' }),
    ).toBeInTheDocument();

    // The day already seen is served from the cache, so only the label proves the move.
    await user.click(screen.getByRole('button', { name: 'Día anterior' }));
    expect(
      await screen.findByText('sábado 17 de octubre', { selector: '[aria-live]' }),
    ).toBeInTheDocument();
  });

  it('switches to the week and asks for Monday to the next Monday', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const { feedUrls } = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Semana' }));

    await waitFor(() => {
      expect(params(feedUrls.at(-1)).get('from')).toBe('2026-10-12T03:00:00.000Z');
    });
    expect(params(feedUrls.at(-1)).get('to')).toBe('2026-10-19T03:00:00.000Z');
    expect(await screen.findAllByRole('group', { name: /^Agenda del / })).toHaveLength(7);
  });

  it('shows a single professional when only that one is chosen', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const { feedUrls } = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Dr. Beto Ruiz' }));

    await waitFor(() => {
      expect(params(feedUrls.at(-1)).get('professionalIds')).toBe(IDS.beto);
    });
    expect(
      screen.queryByRole('group', { name: 'Agenda de Dra. Ana Pérez' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Agenda de Dr. Beto Ruiz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dr. Beto Ruiz' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps the state of the screen in the address, so it survives a reload', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const app = open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Semana' }));

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ view: 'week', date: '2026-10-17' });
    });
  });
});

describe('who sees which agenda', () => {
  it('shows a professional their own agenda only, asking the API for exactly that', async () => {
    setViewport(1280);
    const { feedUrls } = open({ me: ANA_USER });

    expect(
      await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Agenda de Dr. Beto Ruiz' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dr. Beto Ruiz' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(params(feedUrls.at(-1)).get('professionalIds')).toBe(IDS.ana);
    });
  });

  it('offers a professional with a delegated calendar the colleagues to look at', async () => {
    setViewport(1280);
    const delegated = meFor(['professional'], {
      user: { id: IDS.anaMembership, email: 'cardiologia@demo.invalid' },
      grants: ['scheduling.delegated_calendar'],
    });
    open({ me: delegated });

    expect(await screen.findByRole('button', { name: 'Dr. Beto Ruiz' })).toBeInTheDocument();
  });

  it('shows no access, and fetches nothing, to a role without scheduling permissions', async () => {
    const app = open({ me: meFor(['patient']) });

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(app.requests.filter((request) => request.includes('/appointments'))).toEqual([]);
  });
});

describe('the agenda on a phone', () => {
  it('shows the day as a list with the status in words and no grid', async () => {
    setViewport(360);
    open();

    const list = await screen.findByRole('region', { name: 'Agenda del sábado 17 de octubre' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('Confirmado')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Agenda de / })).not.toBeInTheDocument();
  });

  it('is accessible', async () => {
    setViewport(360);
    const { container } = open();
    await screen.findByRole('region', { name: 'Agenda del sábado 17 de octubre' });

    expect(await a11yViolations(container)).toEqual([]);
  });

  it('lets a desktop user switch to the list too', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Lista' }));

    expect(await screen.findAllByRole('listitem')).not.toHaveLength(0);
    expect(
      screen.queryByRole('group', { name: 'Agenda de Dra. Ana Pérez' }),
    ).not.toBeInTheDocument();
  });
});

describe('when the answer is partial or fails', () => {
  it('asks the person to narrow the filter when the server cut the answer', async () => {
    setViewport(1280);
    open({
      feed: () =>
        jsonResponse({ appointments: FEED_ENTRIES, blocks: [], holidays: [], truncated: true }),
    });

    expect(
      await screen.findByText(
        'Hay más turnos de los que se pueden mostrar. Elija menos profesionales o un período más corto.',
      ),
    ).toBeInTheDocument();
    // It does not block the screen: the appointments that did arrive are still there.
    expect(screen.getByRole('button', { name: /Gómez, Valentina/ })).toBeInTheDocument();
  });

  it('shows a retryable error and no appointments when the feed fails', async () => {
    setViewport(1280);
    open({ feed: () => problemResponse(500, 'internal_error') });

    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Gómez/ })).not.toBeInTheDocument();
  });
});

describe('booking from the agenda', () => {
  it('opens the booking dialog from the button', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    open();
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    await user.click(screen.getByRole('button', { name: 'Nuevo turno' }));

    expect(await screen.findByRole('dialog', { name: 'Nuevo turno' })).toBeInTheDocument();
  });

  it('opens on the day on screen, for the professional when only one is shown', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    open({ path: `/calendar?date=2026-10-20&pros=${IDS.beto}` });
    await screen.findByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });

    await user.click(screen.getByRole('button', { name: 'Nuevo turno' }));

    const dialog = await screen.findByRole('dialog', { name: 'Nuevo turno' });
    expect(within(dialog).getByLabelText('Fecha')).toHaveValue('2026-10-20');
    expect(within(dialog).getByLabelText('Profesional')).toHaveValue(IDS.beto);
  });

  it('opens it with the professional and the time of an empty stretch of the grid', async () => {
    setViewport(1280);
    open();
    const column = await screen.findByRole('group', { name: 'Agenda de Dr. Beto Ruiz' });
    const body = column.querySelector('[data-column-body]');
    expect(body).not.toBeNull();
    vi.spyOn(body as Element, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      width: 200,
      height: 1000,
      bottom: 1000,
      right: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // 07:00 + 144 px / 1.2 = 09:00.
    fireEvent.click(body as Element, { clientY: 144, clientX: 20 });

    const dialog = await screen.findByRole('dialog', { name: 'Nuevo turno' });
    expect(within(dialog).getByLabelText('Profesional')).toHaveValue(IDS.beto);
    expect(
      await within(dialog).findByText(/Horario elegido: sábado 17 de octubre, 09:00/),
    ).toBeInTheDocument();
  });

  it('does not offer to book to a role that cannot, and explains it when the organization is read-only', async () => {
    setViewport(1280);
    const readOnly = meFor(['reception'], {
      user: { id: IDS.receptionMembership, email: 'recepcion@demo.invalid' },
      tenantStatus: 'read_only',
    });
    open({ me: readOnly });
    await screen.findByRole('group', { name: 'Agenda de Dra. Ana Pérez' });

    const button = screen.getByRole('button', { name: 'Nuevo turno' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('No disponible en modo de solo lectura.');
  });
});

describe('moving an appointment', () => {
  const MOVE_URL = `POST /api/appointments/${IDS.appointmentGomez}/reschedule`;
  const CONFLICT = {
    conflict: { startsAt: '2026-10-17T13:15:00.000Z', endsAt: '2026-10-17T13:45:00.000Z' },
    nextSlots: [{ startsAt: '2026-10-17T14:30:00.000Z', endsAt: '2026-10-17T15:00:00.000Z' }],
  };

  function moved(version: number, startsAt: string, endsAt: string) {
    return { ...FEED_ENTRIES[0], version, startsAt, endsAt };
  }

  /** What the API answers with: the appointment, without the names the feed adds. */
  function asAppointment(entry: object) {
    const names = new Set(['patientName', 'typeName', 'typeColor']);
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !names.has(key)));
  }

  async function pressAltDown() {
    const card = await screen.findByRole('button', { name: /Gómez, Valentina/ });
    fireEvent.keyDown(card, { key: 'ArrowDown', altKey: true });
  }

  it('shows the new time at once, and puts it back with the next free times if the server refuses', async () => {
    setViewport(1280);
    let release: (response: Response) => void = () => undefined;
    const bodies: unknown[] = [];
    open({
      routes: {
        [MOVE_URL]: (_url, init) => {
          bodies.push(jsonBody(init));
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
      },
    });

    await pressAltDown();

    // Optimistic: the card is already at 10:15 while the request is still in flight.
    expect(await screen.findByRole('button', { name: /10:15 a 10:45.*Gómez/ })).toBeInTheDocument();
    expect(bodies).toEqual([{ expectedVersion: 3, startsAt: '2026-10-17T13:15:00.000Z' }]);

    release(problemResponse(409, 'slot_taken', 'req-1'));
    // (A problem without the extension still rolls back; the one with next times is checked below.)
    expect(await screen.findByRole('button', { name: /10:00 a 10:30.*Gómez/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /10:15 a 10:45/ })).not.toBeInTheDocument();
  });

  it('tells which times are free instead when the server answers with them', async () => {
    setViewport(1280);
    open({
      routes: {
        [MOVE_URL]: () =>
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'slot_taken',
              status: 409,
              code: 'slot_taken',
              i18nKey: 'errors.slot_taken',
              requestId: 'req-2',
              ...CONFLICT,
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          ),
      },
    });

    await pressAltDown();

    expect(await screen.findByText(/Próximos horarios libres: 11:30/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /10:00 a 10:30.*Gómez/ })).toBeInTheDocument();
  });

  it('keeps the move and offers to undo it', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let current = FEED_ENTRIES[0];
    open({
      feed: () =>
        jsonResponse({
          appointments: [current, ...FEED_ENTRIES.slice(1)],
          blocks: [],
          holidays: [],
        }),
      routes: {
        [MOVE_URL]: (_url, init) => {
          bodies.push(jsonBody(init));
          current = moved(
            bodies.length === 1 ? 4 : 5,
            bodies.length === 1 ? '2026-10-17T13:15:00.000Z' : '2026-10-17T13:00:00.000Z',
            bodies.length === 1 ? '2026-10-17T13:45:00.000Z' : '2026-10-17T13:30:00.000Z',
          ) as typeof current;
          return jsonResponse(asAppointment(current));
        },
      },
    });

    await pressAltDown();
    await user.click(await screen.findByRole('button', { name: 'Deshacer' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    // The undo names the version the move produced, and goes back to the original time.
    expect(bodies[1]).toEqual({ expectedVersion: 4, startsAt: '2026-10-17T13:00:00.000Z' });
    expect(await screen.findByRole('button', { name: /10:00 a 10:30.*Gómez/ })).toBeInTheDocument();
  });

  it('does not let a role that cannot book move anything', async () => {
    setViewport(1280);
    const bodies: unknown[] = [];
    open({
      me: meFor(['patient']),
      routes: { [MOVE_URL]: (_url, init) => jsonResponse(bodies.push(jsonBody(init))) },
    });
    // Patients have no agenda at all: nothing to move, nothing requested.
    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });
});
