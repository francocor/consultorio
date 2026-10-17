import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';
import { resetViewportAfterEach, setViewport } from '../../shared/test/viewport.js';

import { FEED_ENTRIES, IDS, LOCATIONS, PROFESSIONALS } from './fixtures.js';

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
