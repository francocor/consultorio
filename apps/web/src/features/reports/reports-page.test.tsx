import {
  APPOINTMENT_STATUSES,
  type OperationalReportResponse,
  type ReportOptionsResponse,
  type ReportRecordsResponse,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

const ids = {
  location: '0190a000-0000-7000-8000-0000000000e1',
  other: '0190a000-0000-7000-8000-0000000000e2',
  professional: '0190a000-0000-7000-8000-0000000000d1',
  patient: '0190a000-0000-7000-8000-0000000000b1',
  appointment: '0190a000-0000-7000-8000-0000000000a1',
};

const row = { total: 100, attended: 88, noShow: 12, cancelled: 30, noShowRateBp: 1200 };

function counts(overrides: Partial<Record<(typeof APPOINTMENT_STATUSES)[number], number>> = {}) {
  return Object.fromEntries(
    APPOINTMENT_STATUSES.map((status) => [status, overrides[status] ?? 0]),
  ) as Record<(typeof APPOINTMENT_STATUSES)[number], number>;
}

const filters = {
  from: '2031-05-01',
  to: '2031-05-31',
  locationId: null,
  professionalId: null,
  specialty: null,
  scope: 'organization' as const,
};

function report(overrides: Partial<OperationalReportResponse> = {}): OperationalReportResponse {
  return {
    filters,
    generatedAt: '2031-06-01T12:00:00.000Z',
    totalAppointments: 130,
    byStatus: counts({ attended: 88, no_show: 12, cancelled: 30 }),
    noShow: {
      attended: 88,
      noShow: 12,
      rateBp: 1200,
      excluded: { cancelled: 30, notFinal: 5, notFinalPast: 3 },
    },
    occupancy: { bookedMinutes: 3000, availableMinutes: 6000, rateBp: 5000 },
    patients: { new: 20, returning: 70 },
    rescheduled: 10,
    sources: { staff: 90, online: 35, waitlistOffer: 5, onlineShareBp: 2692 },
    waitlist: { recoveredSlots: 5 },
    confirmations: { confirmedByPatient: 40, rateBp: 4000 },
    byDay: [
      { date: '2031-05-12', ...row, total: 10 },
      { date: '2031-05-13', ...row, total: 8 },
    ],
    byLocation: [{ locationId: ids.location, name: 'Centro', ...row }],
    byProfessional: [{ professionalId: ids.professional, name: 'Dra. Ríos', ...row }],
    bySpecialty: [{ specialty: 'clinica', ...row }],
    ...overrides,
  };
}

const record = {
  appointmentId: ids.appointment,
  startsAt: '2031-05-12T13:00:00.000Z',
  localDate: '2031-05-12',
  localTime: '10:00',
  status: 'no_show' as const,
  source: 'online' as const,
  rescheduled: true,
  patientId: ids.patient,
  patientName: 'Fernández, Lucía',
  locationId: ids.location,
  locationName: 'Centro',
  professionalId: ids.professional,
  professionalName: 'Dra. Ríos',
  appointmentTypeName: 'Control',
};

function records(overrides: Partial<ReportRecordsResponse> = {}): ReportRecordsResponse {
  return {
    filters,
    group: 'all',
    total: 1,
    limit: 20,
    offset: 0,
    records: [record],
    ...overrides,
  };
}

function options(overrides: Partial<ReportOptionsResponse> = {}): ReportOptionsResponse {
  return {
    scope: 'organization',
    locations: [
      { id: ids.location, name: 'Centro' },
      { id: ids.other, name: 'Norte' },
    ],
    professionals: [
      { id: ids.professional, name: 'Dra. Ríos' },
      { id: '0190a000-0000-7000-8000-0000000000d2', name: 'Dr. Paz' },
    ],
    specialties: ['clinica', 'pediatria'],
    canSeeRevenueByProfessional: true,
    maxSpanDays: 366,
    ...overrides,
  };
}

/** The dashboard tile with that label (a table column can carry the same word). */
async function tile(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name, { selector: 'dt' })).closest('div') as HTMLElement;
}

let missing: string[] | undefined;

// jsdom has no layout: Recharts says its container is 0 pixels wide. The charts are covered by
// the browser spec; here the data, the tables and the states are what is tested.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

interface Setup {
  roles?: Parameters<typeof meFor>[0];
  readOnly?: boolean;
  report?: () => Response;
  records?: (url: string) => Response;
  options?: ReportOptionsResponse;
}

function open(setup: Setup = {}) {
  const urls: string[] = [];
  const app = renderApp({
    path: '/reports',
    me: meFor(setup.roles ?? ['owner'], setup.readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/reports/options': () => jsonResponse(setup.options ?? options()),
      'GET /api/reports/operational': (url) => {
        urls.push(url);
        return setup.report ? setup.report() : jsonResponse(report());
      },
      'GET /api/reports/operational/records': (url) => {
        urls.push(url);
        return setup.records ? setup.records(url) : jsonResponse(records());
      },
    },
  });
  missing = app.missingKeys;
  return { app, urls };
}

describe('the reports dashboard', () => {
  it('shows the numbers of the period with how each was worked out', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Informes' })).toBeVisible();
    const noShow = await tile('Ausentismo');
    expect(within(noShow).getByText('12%')).toBeVisible();
    expect(
      within(noShow).getByText('12 ausentes de 100 turnos con asistencia resuelta'),
    ).toBeVisible();
    const occupancy = screen.getByText('Ocupación').closest('div') as HTMLElement;
    expect(within(occupancy).getByText('50%')).toBeVisible();
    expect(within(occupancy).getByText('50 h reservadas de 100 h disponibles')).toBeVisible();
    expect(screen.getByText('Reservas en línea').closest('div')).toHaveTextContent('26,9%');
    expect(screen.getByText('Turnos reprogramados').closest('div')).toHaveTextContent('10');
    expect(
      screen.getByText('Quedan fuera del ausentismo: 30 cancelados y 5 sin estado final.'),
    ).toBeVisible();
    expect(screen.getByText(/3 de los turnos sin estado final ya pasaron/)).toBeVisible();
  });

  it('shows no rate, not 0%, when nothing has a final state yet', async () => {
    open({
      report: () =>
        jsonResponse(
          report({
            noShow: {
              attended: 0,
              noShow: 0,
              rateBp: null,
              excluded: { cancelled: 0, notFinal: 4, notFinalPast: 0 },
            },
            byStatus: counts({ scheduled: 4 }),
            totalAppointments: 4,
          }),
        ),
    });

    const noShow = await tile('Ausentismo');
    expect(within(noShow).getByText('–')).toBeVisible();
    expect(within(noShow).getByText('Todavía no hay turnos con asistencia resuelta')).toBeVisible();
  });

  it('says which filters are applied, and in whose name the figures are cut', async () => {
    open();

    await tile('Ausentismo');

    expect((await screen.findByText(/Filtros aplicados/)).closest('p')).toHaveTextContent(
      /Filtros aplicados: Del \d{2}\/\d{2}\/\d{4} al \d{2}\/\d{2}\/\d{4} · Toda la organización/,
    );
  });

  it('offers a table with the same data as every chart, and opens the list of a status from it', async () => {
    const user = userEvent.setup();
    const { urls } = open();

    // The chart is the first view and is loaded on demand.
    expect(
      await screen.findByRole('img', { name: 'Gráfico de barras: cantidad de turnos por estado' }),
    ).toBeVisible();
    const status = screen.getByRole('heading', { name: 'Turnos por estado' }).closest('section');
    await user.click(within(status as HTMLElement).getByRole('tab', { name: 'Tabla' }));
    const table = within(status as HTMLElement).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    expect(
      within(within(table).getByRole('row', { name: /Ausente/ })).getByText('12'),
    ).toBeVisible();

    await user.click(
      within(table).getByRole('button', { name: 'Ver los turnos en estado Ausente' }),
    );

    await waitFor(() => {
      expect(urls.some((url) => url.includes('group=no_show'))).toBe(true);
    });
    expect(screen.getByLabelText('Mostrar')).toHaveValue('no_show');
  });

  it('has a table for the days, with the date as written in Argentina', async () => {
    const user = userEvent.setup();
    open();

    const series = (await screen.findByRole('heading', { name: 'Turnos por día' })).closest(
      'section',
    ) as HTMLElement;
    await user.click(await within(series).findByRole('tab', { name: 'Tabla' }));

    const table = within(series).getByRole('table');
    expect(within(table).getByRole('cell', { name: '12/05/2031' })).toBeVisible();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 2);
  });

  it('cuts the figures by place, professional and specialty', async () => {
    const user = userEvent.setup();
    open();

    const section = (
      await screen.findByRole('heading', { name: 'Detalle por sede, profesional y especialidad' })
    ).closest('section') as HTMLElement;
    expect(await within(section).findByRole('cell', { name: 'Centro' })).toBeVisible();
    await user.click(within(section).getByRole('tab', { name: 'Por profesional' }));
    expect(within(section).getByRole('cell', { name: 'Dra. Ríos' })).toBeVisible();
    await user.click(within(section).getByRole('tab', { name: 'Por especialidad' }));
    expect(within(section).getByRole('cell', { name: 'clinica' })).toBeVisible();
  });

  it('lists the appointments behind the numbers with the patient identified, and pages through them', async () => {
    const user = userEvent.setup();
    const { urls } = open({
      records: (url) =>
        jsonResponse(
          records({
            total: 45,
            offset: url.includes('offset=20') ? 20 : 0,
            records: [record],
          }),
        ),
    });

    const section = (await screen.findByRole('heading', { name: 'Turnos del período' })).closest(
      'section',
    ) as HTMLElement;
    const table = await within(section).findByRole('table');
    expect(within(table).getByRole('cell', { name: 'Fernández, Lucía' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '12/05/2031 10:00' })).toBeVisible();
    expect(within(section).getByText('Reprogramado')).toBeVisible();
    expect(within(section).getByText('Reserva en línea')).toBeVisible();
    expect(within(section).getByText('Mostrando 1 a 1 de 45')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await user.click(within(section).getByRole('button', { name: 'Siguiente' }));

    await waitFor(() => {
      expect(urls.some((url) => url.includes('offset=20'))).toBe(true);
    });
  });

  it('shows an empty state with the way to the agenda in every widget when there are no appointments', async () => {
    open({
      report: () =>
        jsonResponse(
          report({
            totalAppointments: 0,
            byStatus: counts(),
            byDay: [],
            byLocation: [],
            byProfessional: [],
            bySpecialty: [],
            noShow: {
              attended: 0,
              noShow: 0,
              rateBp: null,
              excluded: { cancelled: 0, notFinal: 0, notFinalPast: 0 },
            },
          }),
        ),
      records: () => jsonResponse(records({ total: 0, records: [] })),
    });

    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: 'Ir a la agenda' })).toHaveLength(5);
    });
    const links = screen.getAllByRole('link', { name: 'Ir a la agenda' });
    expect(links[0]).toHaveAttribute('href', '/calendar');
    expect(screen.queryByRole('tab', { name: 'Tabla' })).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('keeps the other widgets working when the figures fail, and retries on its own', async () => {
    const user = userEvent.setup();
    let fails = true;
    open({
      report: () => (fails ? problemResponse(500, 'internal_error') : jsonResponse(report())),
    });

    const section = (await screen.findByRole('heading', { name: 'Turnos del período' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(section).findByRole('table')).toBeVisible();
    const retries = await screen.findAllByRole('button', { name: 'Reintentar' });
    expect(retries.length).toBeGreaterThanOrEqual(4);
    expect(within(section).queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();

    fails = false;
    const first = retries[0];
    if (!first) throw new Error('no retry button');
    await user.click(first);

    expect(await tile('Ausentismo')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('keeps the list working when the list fails, and the figures stay', async () => {
    open({ records: () => problemResponse(500, 'internal_error') });

    expect(await tile('Ausentismo')).toBeVisible();
    const section = screen.getByRole('heading', { name: 'Turnos del período' }).closest('section');
    expect(await within(section as HTMLElement).findByRole('alert')).toBeVisible();
  });

  it('explains an inverted range on the field and does not ask for the report', async () => {
    const user = userEvent.setup();
    const { urls } = open();
    await tile('Ausentismo');
    const before = urls.length;

    const from = screen.getByLabelText('Desde');
    const to = screen.getByLabelText('Hasta');
    await user.clear(from);
    await user.type(from, '2031-05-31');
    await user.clear(to);
    await user.type(to, '2031-05-01');
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La fecha «Hasta» no puede ser anterior a «Desde».',
    );
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(urls).toHaveLength(before);
  });

  it('refuses a period longer than a year, with the limit in the message', async () => {
    const user = userEvent.setup();
    open();
    await tile('Ausentismo');

    const from = screen.getByLabelText('Desde');
    const to = screen.getByLabelText('Hasta');
    await user.clear(from);
    await user.type(from, '2031-01-01');
    await user.clear(to);
    await user.type(to, '2032-06-30');
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El período no puede superar 366 días.',
    );
  });

  it('asks again with the filters chosen and shows them as applied', async () => {
    const user = userEvent.setup();
    const { urls } = open();
    await tile('Ausentismo');

    await user.selectOptions(screen.getByLabelText('Sede'), ids.other);
    await user.selectOptions(screen.getByLabelText('Especialidad'), 'pediatria');
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    await waitFor(() => {
      expect(
        urls.some(
          (url) =>
            url.includes('/reports/operational?') &&
            url.includes(`locationId=${ids.other}`) &&
            url.includes('specialty=pediatria'),
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Sede: Norte/)).toBeVisible();
    expect(screen.getByText(/Especialidad: pediatria/)).toBeVisible();
  });

  it('shows reception only the filters it can use: a single location is not a choice', async () => {
    open({
      roles: ['reception'],
      options: options({
        scope: 'locations',
        locations: [{ id: ids.location, name: 'Centro' }],
        professionals: [],
        specialties: [],
        canSeeRevenueByProfessional: false,
      }),
      report: () => jsonResponse(report({ filters: { ...filters, scope: 'locations' } })),
    });

    expect(await screen.findByText(/Solo las sedes en las que trabaja/)).toBeVisible();
    expect(screen.queryByLabelText('Sede')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Profesional')).not.toBeInTheDocument();
  });

  it('loads in a read-only organization: reading a report is never blocked', async () => {
    open({ readOnly: true });

    expect(await tile('Ausentismo')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Aplicar filtros' })).toBeEnabled();
  });

  it('has no accessibility violations', async () => {
    const { app } = open();
    await tile('Ausentismo');
    await within(
      await screen
        .findByRole('heading', { name: 'Turnos del período' })
        .then((h) => h.closest('section') as HTMLElement),
    ).findByRole('table');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
