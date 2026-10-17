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

import { BookingDialog } from './components/BookingDialog.js';
import type { SchedulingProfessional } from './containers/use-scheduling-people.js';
import { IDS, LOCATIONS, TYPES } from './fixtures.js';

const ANA: SchedulingProfessional = {
  id: IDS.ana,
  membershipId: IDS.anaMembership,
  name: 'Dra. Ana Pérez',
  specialties: ['Cardiología'],
  locationIds: [IDS.central],
};

const WEEK = 7 * 86_400_000;
const at = (weeks: number) =>
  new Date(Date.parse('2026-10-17T13:00:00.000Z') + weeks * WEEK).toISOString();

function occurrence(
  index: number,
  startsAt: string | null,
  status: 'ok' | 'conflict' | 'skipped',
  reason: string | null = null,
) {
  return {
    index,
    startsAt,
    endsAt:
      startsAt === null ? null : new Date(new Date(startsAt).getTime() + 45 * 60_000).toISOString(),
    status,
    reason,
  };
}

const ALL_OK = {
  mode: 'dry_run',
  canCommit: true,
  occurrences: [occurrence(1, at(0), 'ok'), occurrence(2, at(1), 'ok'), occurrence(3, at(2), 'ok')],
};

const ONE_CONFLICT = {
  mode: 'dry_run',
  canCommit: false,
  occurrences: [
    occurrence(1, at(0), 'ok'),
    occurrence(2, at(1), 'conflict', 'blocked'),
    occurrence(3, at(2), 'ok'),
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
      requestId: 'req-1',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function mount(preview: unknown, commit?: (body: unknown) => Response) {
  const calls: Record<string, unknown>[] = [];
  const onOpenChange = vi.fn();
  const series: FetchHandler = (_url, init) => {
    const body = jsonBody(init) as Record<string, unknown>;
    calls.push(body);
    if (body['mode'] === 'dry_run') return jsonResponse(preview);
    return commit
      ? commit(body)
      : jsonResponse(
          { mode: 'commit', seriesId: IDS.first, appointments: [], skipped: body['skip'] },
          201,
        );
  };
  renderWithApp(
    <BookingDialog
      open
      onOpenChange={onOpenChange}
      professionals={[ANA]}
      locations={LOCATIONS}
      canOverrideHours
      initial={{ professionalId: IDS.ana, start: new Date(at(0)) }}
    />,
    {
      fetch: fakeFetch({
        'GET /api/appointment-types': () => jsonResponse({ types: TYPES }),
        'GET /api/availability': () =>
          jsonResponse({
            professionalId: IDS.ana,
            typeId: IDS.first,
            slots: [
              { startsAt: at(0), endsAt: at(0), locationId: IDS.central, date: '2026-10-17' },
            ],
            closedDays: [],
          }),
        'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
        'POST /api/appointments/series': series,
      }),
    },
  );
  return { calls, onOpenChange };
}

async function startSeries(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(/Horario elegido/);
  await user.type(screen.getByRole('combobox', { name: 'Paciente' }), 'gom');
  await user.click(await screen.findByRole('option', { name: /Gómez, Valentina/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Repetir todas las semanas' }));
  fireEvent.change(screen.getByLabelText('Cantidad de sesiones'), { target: { value: '3' } });
}

describe('a weekly series', () => {
  it('asks for the sessions and reviews them before anything is created', async () => {
    const user = userEvent.setup();
    const app = mount(ALL_OK);
    await startSeries(user);

    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));

    const table = await screen.findByRole('table', { name: 'Sesiones de la serie' });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // the header and three sessions
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]).toMatchObject({
      mode: 'dry_run',
      startsAt: at(0),
      recurrence: { frequency: 'weekly', everyWeeks: 1, count: 3 },
      skip: [],
    });
    // Nothing is created yet: the next step is the explicit one.
    expect(screen.getByRole('button', { name: 'Crear 3 turnos' })).toBeEnabled();
  });

  it('commits the whole series with one click when every session is free', async () => {
    const user = userEvent.setup();
    const app = mount(ALL_OK);
    await startSeries(user);
    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));

    await user.click(await screen.findByRole('button', { name: 'Crear 3 turnos' }));

    await waitFor(() => {
      expect(app.calls).toHaveLength(2);
    });
    expect(app.calls[1]).toMatchObject({ mode: 'commit', skip: [] });
    await waitFor(() => {
      expect(app.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(await screen.findByText('Se crearon 3 turnos.')).toBeInTheDocument();
  });

  it('names the sessions that conflict, and makes the person skip them or give up', async () => {
    const user = userEvent.setup();
    const app = mount(ONE_CONFLICT);
    await startSeries(user);
    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));

    const table = await screen.findByRole('table', { name: 'Sesiones de la serie' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Disponible');
    expect(rows[2]).toHaveTextContent('No disponible: horario bloqueado');
    // As it is the series cannot be created: the commit waits for a decision.
    expect(screen.getByRole('button', { name: 'Crear 2 turnos' })).toBeDisabled();
    expect(
      screen.getByText('1 sesión no se puede crear. Omítala o vuelva para cambiar la serie.'),
    ).toBeInTheDocument();

    await user.click(within(table).getByRole('checkbox', { name: 'Omitir la sesión 2' }));
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('Omitida');
    expect(screen.getByRole('button', { name: 'Crear 2 turnos' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Crear 2 turnos' }));
    await waitFor(() => {
      expect(app.calls).toHaveLength(2);
    });
    expect(app.calls[1]).toMatchObject({ mode: 'commit', skip: [2] });
  });

  it('creates nothing when the person goes back', async () => {
    const user = userEvent.setup();
    const app = mount(ONE_CONFLICT);
    await startSeries(user);
    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));
    await screen.findByRole('table', { name: 'Sesiones de la serie' });

    await user.click(screen.getByRole('button', { name: 'Volver a la serie' }));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revisar sesiones' })).toBeInTheDocument();
    expect(app.calls).toHaveLength(1);
  });

  it('shows the sessions the server refused when the commit finds a new conflict', async () => {
    const user = userEvent.setup();
    mount(ALL_OK, () =>
      problem(409, 'conflict', {
        occurrences: [
          occurrence(1, at(0), 'ok'),
          occurrence(2, at(1), 'conflict', 'slot_taken'),
          occurrence(3, at(2), 'ok'),
        ],
      }),
    );
    await startSeries(user);
    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));

    await user.click(await screen.findByRole('button', { name: 'Crear 3 turnos' }));

    const table = await screen.findByRole('table', { name: 'Sesiones de la serie' });
    await waitFor(() => {
      expect(within(table).getAllByRole('row')[2]).toHaveTextContent(
        'No disponible: horario ocupado',
      );
    });
    expect(screen.getByRole('button', { name: 'Crear 2 turnos' })).toBeDisabled();
  });

  it('is accessible while reviewing', async () => {
    const user = userEvent.setup();
    mount(ONE_CONFLICT);
    await startSeries(user);
    await user.click(screen.getByRole('button', { name: 'Revisar sesiones' }));
    await screen.findByRole('table', { name: 'Sesiones de la serie' });

    expect(await a11yViolations(screen.getByRole('dialog'))).toEqual([]);
  });
});
