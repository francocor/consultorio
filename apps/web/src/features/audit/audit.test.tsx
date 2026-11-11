import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';
import { PATIENT_IDS, SUMMARIES, patient } from '../patients/fixtures.js';

const ACTOR = '0190a000-0000-7000-8000-000000000001';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: '0190a000-0000-7000-8000-0000000000f1',
    occurredAt: '2026-10-16T15:30:00.000Z',
    actorUserId: ACTOR,
    actorName: 'Marcela Quiroga',
    actingRole: 'owner',
    action: 'staff.invited',
    resourceType: 'membership',
    resourceId: null,
    patientId: null,
    outcome: 'allow',
    reason: null,
    ip: '203.0.113.7',
    requestId: 'req-1',
    metadata: {},
    sealed: true,
    ...overrides,
  };
}

const EVENTS = [
  event(),
  event({
    id: '0190a000-0000-7000-8000-0000000000f2',
    occurredAt: '2026-10-16T14:10:00.000Z',
    actorName: 'Camila Duarte',
    actingRole: 'reception',
    action: 'access.denied',
    resourceType: 'anamnesis',
    outcome: 'deny',
    reason: 'no_relationship',
    sealed: false,
  }),
  event({
    id: '0190a000-0000-7000-8000-0000000000f3',
    occurredAt: '2026-10-16T13:00:00.000Z',
    actorUserId: null,
    actorName: null,
    actingRole: null,
    action: 'future.action',
  }),
];

let current: RenderedApp | undefined;
const queries: URLSearchParams[] = [];

beforeEach(() => {
  queries.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  routes: Record<string, (url: string, init: RequestInit) => Response> = {},
  me = meFor(['owner']),
) {
  current = renderApp({
    me,
    path: '/audit',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/audit-events': (url) => {
        queries.push(new URL(url, 'http://localhost').searchParams);
        const cursor = queries.at(-1)?.get('cursor');
        return jsonResponse(
          cursor
            ? {
                events: [
                  event({ id: '0190a000-0000-7000-8000-0000000000f9', action: 'auth.logout' }),
                ],
                nextCursor: null,
              }
            : { events: EVENTS, nextCursor: 'next-page' },
        );
      },
      'GET /api/patients': () => jsonResponse({ patients: SUMMARIES, nextCursor: null }),
      ...routes,
    },
  });
  return current;
}

describe('audit viewer', () => {
  it('lists who did what, to which kind of record, when, and with what outcome', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Auditoría' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Marcela Quiroga');
    expect(rows[1]).toHaveTextContent('Propietario');
    expect(rows[1]).toHaveTextContent('Invitación de una persona al equipo');
    expect(rows[1]).toHaveTextContent('16/10/2026, 12:30');
    expect(rows[1]).toHaveTextContent('Permitido');
    expect(rows[2]).toHaveTextContent('Camila Duarte');
    expect(rows[2]).toHaveTextContent('Acceso denegado');
    expect(rows[2]).toHaveTextContent('Denegado');
    expect(rows[2]).toHaveTextContent('Pendiente de sellado');
  });

  it('shows an action it does not know as it came, and a system actor calmly', async () => {
    open();

    const table = await screen.findByRole('table');
    const row = within(table).getAllByRole('row')[3];
    expect(row).toHaveTextContent('future.action');
    expect(row).toHaveTextContent('Sistema');
  });

  it('filters by outcome and action, and sends them to the server', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('Resultado'), 'deny');
    await user.selectOptions(screen.getByLabelText('Acción'), 'access.denied');

    await waitFor(() => {
      const last = queries.at(-1);
      expect(last?.get('outcome')).toBe('deny');
      expect(last?.get('action')).toBe('access.denied');
    });
  });

  it('filters by period, in the time zone of the organization', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('table');

    await user.type(screen.getByLabelText('Desde'), '2026-10-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-10-16');

    await waitFor(() => {
      const last = queries.at(-1);
      expect(last?.get('from')).toBe('2026-10-01T03:00:00.000Z');
      // The end day is inclusive: the period ends when the next day starts.
      expect(last?.get('to')).toBe('2026-10-17T03:00:00.000Z');
    });
  });

  it('filters by patient with the picker and can remove that filter', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('table');

    await user.type(screen.getByRole('combobox', { name: 'Paciente' }), 'gom');
    await user.click(await screen.findByRole('option', { name: /Gómez, Valentina/ }));

    await waitFor(() => {
      expect(queries.at(-1)?.get('patientId')).toBe(PATIENT_IDS.valentina);
    });
    await user.click(screen.getByRole('button', { name: 'Quitar el filtro de paciente' }));
    // The unfiltered list is already cached, so no new request is needed to show it again.
    expect(await screen.findByRole('combobox', { name: 'Paciente' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Quitar el filtro de paciente' }),
    ).not.toBeInTheDocument();
  });

  it('loads more events with the cursor', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Ver más eventos' }));

    await waitFor(() => {
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
    });
    expect(queries.at(-1)?.get('cursor')).toBe('next-page');
    expect(screen.queryByRole('button', { name: 'Ver más eventos' })).not.toBeInTheDocument();
  });

  it('says calmly when no event matches and offers to clear the filters', async () => {
    const user = userEvent.setup();
    open({ 'GET /api/audit-events': () => jsonResponse({ events: [], nextCursor: null }) });

    expect(await screen.findByText('No hay eventos para mostrar')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Resultado'), 'deny');
    await user.click(await screen.findByRole('button', { name: 'Limpiar los filtros' }));

    expect(screen.getByLabelText('Resultado')).toHaveValue('');
  });

  it('exports with the filters that are on screen', async () => {
    const user = userEvent.setup();
    let exported = '';
    open({
      'GET /api/audit-events/export': (url) => {
        exported = url;
        return new Response('id,occurredAt\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="audit-2026-10-16.csv"',
          },
        });
      },
    });
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Resultado'), 'deny');

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    await waitFor(() => {
      expect(exported).toContain('format=csv');
      expect(exported).toContain('outcome=deny');
    });
    expect(await screen.findByText('Exportación lista.')).toBeInTheDocument();
  });

  it('reception cannot open it', async () => {
    open({}, meFor(['reception']));

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(current?.requests.some((request) => request.includes('/audit-events'))).toBe(false);
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByRole('table');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('access report of a patient', () => {
  const ID = PATIENT_IDS.valentina;

  function openRecord(me = meFor(['owner'])) {
    current = renderApp({
      me,
      path: `/patients/${ID}`,
      boot: bootFor('Centro Médico Aillu'),
      routes: {
        [`GET /api/patients/${ID}`]: () => jsonResponse(patient()),
        [`GET /api/patients/${ID}/representatives`]: () =>
          jsonResponse({ minor: false, representatives: [] }),
        [`GET /api/patients/${ID}/access-report`]: () =>
          jsonResponse({
            events: [
              event({ action: 'patient.read', patientId: ID, resourceType: 'patient' }),
              event({
                id: '0190a000-0000-7000-8000-0000000000f4',
                actorName: 'Dra. Lucía Paz Ferrer',
                actingRole: 'professional',
                action: 'clinical.anamnesis.read',
                patientId: ID,
                resourceType: 'anamnesis',
              }),
            ],
            nextCursor: null,
          }),
      },
    });
    return current;
  }

  it('lists who accessed the record, without any clinical content', async () => {
    const user = userEvent.setup();
    openRecord();

    await user.click(await screen.findByRole('tab', { name: 'Accesos' }));

    const list = await screen.findByRole('table');
    expect(within(list).getByText('Marcela Quiroga')).toBeInTheDocument();
    expect(within(list).getByText('Dra. Lucía Paz Ferrer')).toBeInTheDocument();
    expect(within(list).getByText('Lectura de la anamnesis')).toBeInTheDocument();
    expect(within(list).getByText('Consulta de la ficha')).toBeInTheDocument();
  });

  it('is only offered to whoever can read the audit trail', async () => {
    openRecord(meFor(['reception']));

    await screen.findByRole('heading', { level: 1, name: 'Valentina Gómez' });
    expect(screen.queryByRole('tab', { name: 'Accesos' })).not.toBeInTheDocument();
  });
});
