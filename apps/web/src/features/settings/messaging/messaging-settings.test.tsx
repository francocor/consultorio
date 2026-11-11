import { DEFAULT_SETTINGS_SECTIONS, type UsageResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../../shared/test/render.js';

/** The item at a position, or a failure that names it. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

type Handler = (url: string, init: RequestInit) => Response;

const settings = (overrides: Record<string, unknown> = {}) => ({
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  ...overrides,
});

const usage = (professionals: UsageResponse['professionals'] = []): UsageResponse => ({
  period: '2031-05',
  professionals,
});

const DOCTOR = '0190a000-0000-7000-8000-0000000000d1';
const COLLEAGUE = '0190a000-0000-7000-8000-0000000000d2';

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, Handler> = {}, loaded = settings(), me = meFor(['owner'])) {
  current = renderApp({
    me,
    path: '/settings/messaging',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/settings': () => jsonResponse(loaded),
      'GET /api/notifications/usage': () => jsonResponse(usage()),
      ...routes,
    },
  });
  return current;
}

describe('Settings > Mensajes', () => {
  it('shows up as a section of Settings for whoever manages notifications', async () => {
    open();

    const nav = await screen.findByRole('navigation', { name: /Secciones/i });
    expect(within(nav).getByRole('link', { name: 'Mensajes' })).toBeInTheDocument();
  });

  it('shows the lead times, the quiet hours, the wording and the WhatsApp switch as they are', async () => {
    open(
      undefined,
      settings({
        notifications: {
          reminderLeadHours: [72, 24],
          hideProfessional: true,
          hideAppointmentType: false,
        },
        integrations: { whatsapp: false, video: true, einvoicing: false },
      }),
    );

    expect(await screen.findByLabelText('Recordatorio 1: horas antes del turno')).toHaveValue('72');
    expect(screen.getByLabelText('Recordatorio 2: horas antes del turno')).toHaveValue('24');
    expect(
      screen.queryByLabelText('Recordatorio 3: horas antes del turno'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Desde')).toHaveValue('21:00');
    expect(screen.getByLabelText('Hasta')).toHaveValue('08:00');
    expect(screen.getByRole('switch', { name: 'No nombrar al profesional' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'No nombrar el tipo de turno' })).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Enviar recordatorios por WhatsApp' }),
    ).not.toBeChecked();
  });

  it('adds up to three reminders and takes them away', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText('Recordatorio 1: horas antes del turno');

    await user.click(screen.getByRole('button', { name: 'Agregar otro recordatorio' }));
    await user.click(screen.getByRole('button', { name: 'Agregar otro recordatorio' }));

    expect(screen.getByLabelText('Recordatorio 3: horas antes del turno')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Agregar otro recordatorio' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Quitar el recordatorio 3' }));
    expect(
      screen.queryByLabelText('Recordatorio 3: horas antes del turno'),
    ).not.toBeInTheDocument();
  });

  it('says in Spanish, next to the field, what is wrong with a lead time, and saves nothing', async () => {
    const user = userEvent.setup();
    const app = open({ 'PATCH /api/settings': () => jsonResponse(settings()) });
    const first = await screen.findByLabelText('Recordatorio 1: horas antes del turno');
    await user.clear(first);
    await user.type(first, '0');
    await user.click(screen.getByRole('button', { name: 'Agregar otro recordatorio' }));
    await user.type(screen.getByLabelText('Recordatorio 2: horas antes del turno'), '0');

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    const alerts = await screen.findAllByText('Ingrese un número entero entre 1 y 336.');
    expect(alerts).toHaveLength(2);
    expect(first).toHaveAccessibleDescription('Ingrese un número entero entre 1 y 336.');
    expect(first).toBeInvalid();
    expect(app.requests).not.toContain('PATCH /api/settings');
  });

  it('refuses a repeated number and an empty one with their own messages', async () => {
    const user = userEvent.setup();
    open();
    const first = await screen.findByLabelText('Recordatorio 1: horas antes del turno');
    await user.click(screen.getByRole('button', { name: 'Agregar otro recordatorio' }));
    await user.type(screen.getByLabelText('Recordatorio 2: horas antes del turno'), '24');
    await user.click(screen.getByRole('button', { name: 'Agregar otro recordatorio' }));
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect(
      await screen.findByText('Las horas no pueden repetirse entre recordatorios.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Ingrese las horas.')).toBeInTheDocument();
    expect(first).not.toBeInvalid();
  });

  it('sends only what changed when saving', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          settings({
            notifications: {
              reminderLeadHours: [48],
              hideProfessional: false,
              hideAppointmentType: false,
            },
          }),
        );
      },
    });
    const first = await screen.findByLabelText('Recordatorio 1: horas antes del turno');
    await user.clear(first);
    await user.type(first, '48');

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(body).toEqual({ notifications: { reminderLeadHours: [48] } });
    });
    expect(await screen.findByText('Configuración guardada.')).toBeInTheDocument();
  });

  it('saves the wording, the quiet hours and the WhatsApp switch together', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(settings());
      },
    });
    await user.click(await screen.findByRole('switch', { name: 'No nombrar al profesional' }));
    await user.click(screen.getByRole('switch', { name: 'Enviar recordatorios por WhatsApp' }));
    const start = screen.getByLabelText('Desde');
    await user.clear(start);
    await user.type(start, '22:00');

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(body).toEqual({
        notifications: { hideProfessional: true },
        quietHours: { start: '22:00', end: '08:00' },
        integrations: { whatsapp: false },
      });
    });
  });

  it('allows no reminder at all, which switches them off', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          settings({
            notifications: {
              reminderLeadHours: [],
              hideProfessional: false,
              hideAppointmentType: false,
            },
          }),
        );
      },
    });
    await screen.findByLabelText('Recordatorio 1: horas antes del turno');
    await user.click(screen.getByRole('button', { name: 'Quitar el recordatorio 1' }));
    expect(
      screen.getByText('No hay recordatorios configurados: no se enviará ninguno.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(body).toEqual({ notifications: { reminderLeadHours: [] } });
    });
  });

  it('shows the server problem when saving fails', async () => {
    const user = userEvent.setup();
    open({
      'PATCH /api/settings': () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            code: 'forbidden',
            i18nKey: 'errors.forbidden',
            requestId: 'r-1',
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await user.click(await screen.findByRole('switch', { name: 'No nombrar al profesional' }));

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect(
      await screen.findByText('No tiene permiso para realizar esta acción.'),
    ).toBeInTheDocument();
  });

  it('is not offered to reception: it sees the no-access state, not the form', async () => {
    open(undefined, settings(), meFor(['reception']));

    expect(await screen.findByText(/No tiene acceso/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Recordatorio 1: horas antes del turno'),
    ).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByLabelText('Recordatorio 1: horas antes del turno');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('Settings > Mensajes: WhatsApp usage', () => {
  const rows: UsageResponse['professionals'] = [
    { professionalId: DOCTOR, name: 'Dra. Ríos', count: 120, limit: 200, state: 'ok' },
    { professionalId: COLLEAGUE, name: null, count: 170, limit: 200, state: 'warning' },
    {
      professionalId: '0190a000-0000-7000-8000-0000000000d3',
      name: 'Dr. Paz',
      count: 200,
      limit: 200,
      state: 'exhausted',
    },
    {
      professionalId: '0190a000-0000-7000-8000-0000000000d4',
      name: 'Dra. Sol',
      count: 7,
      limit: null,
      state: 'unlimited',
    },
  ];

  it('lists each professional with the count, the quota and the state in words', async () => {
    open({ 'GET /api/notifications/usage': () => jsonResponse(usage(rows)) });

    const table = await screen.findByRole('table', {
      name: 'Mensajes de WhatsApp por profesional',
    });
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(4);
    expect(within(at(body, 0)).getByText('Dra. Ríos')).toBeInTheDocument();
    expect(within(at(body, 0)).getByText('120')).toBeInTheDocument();
    expect(within(at(body, 0)).getByText('Dentro del cupo')).toBeInTheDocument();
    expect(within(at(body, 1)).getByText('Profesional sin nombre')).toBeInTheDocument();
    expect(within(at(body, 1)).getByText('Cerca del cupo (80% o más)')).toBeInTheDocument();
    expect(within(at(body, 2)).getByText('Cupo agotado')).toBeInTheDocument();
    expect(within(at(body, 3)).getAllByText('Sin cupo')).toHaveLength(2);
    expect(
      screen.getByText(/Mensajes de WhatsApp que el proveedor aceptó en 2031-05/),
    ).toBeInTheDocument();
  });

  it('says there is nobody to count when there are no active professionals', async () => {
    open();

    expect(await screen.findByText('Todavía no hay profesionales activos.')).toBeInTheDocument();
  });

  it('has no accessibility violations with the usage table', async () => {
    const app = open({ 'GET /api/notifications/usage': () => jsonResponse(usage(rows)) });
    await screen.findByRole('table', { name: 'Mensajes de WhatsApp por profesional' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
