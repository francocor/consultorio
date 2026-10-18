import {
  money,
  type CashEntryDto,
  type CashSessionDto,
  type LocationDto,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { IDS, session } from './test-fixtures.js';

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

const centro: LocationDto = {
  id: IDS.location,
  name: 'Centro',
  timeZone: 'America/Argentina/Buenos_Aires',
  active: true,
};
const norte: LocationDto = {
  id: '0190a000-0000-7000-8000-0000000000e2',
  name: 'Norte',
  timeZone: 'America/Argentina/Buenos_Aires',
  active: true,
};

const entry = (overrides: Partial<CashEntryDto> = {}): CashEntryDto => ({
  kind: 'payment',
  id: IDS.payment,
  paymentId: IDS.payment,
  chargeId: IDS.charge,
  patientName: 'Lucía Fernández',
  method: 'cash',
  amountCents: money(1_234_50),
  reason: null,
  at: '2031-05-12T13:10:00.000Z',
  ...overrides,
});

interface Setup {
  locations?: LocationDto[];
  current?: CashSessionDto | null;
  closed?: CashSessionDto[];
  entries?: CashEntryDto[];
  roles?: Parameters<typeof meFor>[0];
  readOnly?: boolean;
  routes?: Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>;
}

function open({
  locations = [centro],
  current = null,
  closed = [],
  entries = [],
  roles = ['reception'],
  readOnly = false,
  routes = {},
}: Setup = {}) {
  const app = renderApp({
    path: '/cash',
    me: meFor(roles, readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/locations': () => jsonResponse({ locations }),
      'GET /api/billing/cash/current': (url) => {
        const wanted = new URL(url, 'http://localhost').searchParams.get('locationId');
        return jsonResponse({ session: current && current.locationId === wanted ? current : null });
      },
      'GET /api/billing/cash/sessions': () => jsonResponse({ sessions: closed }),
      ...(current
        ? {
            [`GET /api/billing/cash/sessions/${current.id}`]: () =>
              jsonResponse({ session: current, entries }),
          }
        : {}),
      ...routes,
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('the cash register screen', () => {
  it('offers to open the register when there is none, with the opening cash in pesos', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      routes: {
        'POST /api/billing/cash/sessions': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(session(), 201);
        },
      },
    });

    expect(await screen.findByText(/La caja de Centro está cerrada/)).toBeVisible();
    const submit = screen.getByRole('button', { name: 'Abrir caja' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Efectivo con el que empieza'), '5000');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toEqual([{ locationId: IDS.location, openingCents: 500_000 }]);
    });
  });

  it('shows the open register: opening cash, cash taken, what should be there, and the day by method', async () => {
    open({ current: session(), entries: [entry()] });

    expect(await screen.findByRole('heading', { name: 'Caja de Centro' })).toBeVisible();
    const summary = await screen.findByText('Efectivo que debería haber', { selector: 'dt' });
    expect(summary.nextElementSibling).toHaveTextContent('$ 35.000,00');
    expect(screen.getByText('Efectivo al abrir').nextElementSibling).toHaveTextContent(
      '$ 5.000,00',
    );
    const table = screen.getByRole('table', { name: 'Por medio de pago' });
    expect(within(table).getByRole('row', { name: /Débito.*\$ 1\.234,50/ })).toBeVisible();
    expect(await screen.findByRole('list', { name: 'Movimientos de la caja' })).toBeVisible();
    expect(screen.getByText('$ 1.234,50', { selector: 'span.tabular-nums' })).toBeVisible();
  });

  it('closes the register with the exact count and sends no reason', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      current: session(),
      routes: {
        [`POST /api/billing/cash/sessions/${IDS.session}/close`]: (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(session({ status: 'closed' }));
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cerrar caja' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar la caja' });
    expect(within(dialog).getByRole('button', { name: 'Cerrar caja' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Efectivo contado'), '35000');
    expect(within(dialog).getByText('El efectivo coincide con lo esperado.')).toBeVisible();
    expect(within(dialog).queryByLabelText('Motivo de la diferencia')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar caja' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ countedCents: 3_500_000 }]);
    });
  });

  it('needs a reason when the count is short, says how much is missing, and sends the reason', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      current: session(),
      routes: {
        [`POST /api/billing/cash/sessions/${IDS.session}/close`]: (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(session({ status: 'closed' }));
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cerrar caja' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar la caja' });
    await user.type(within(dialog).getByLabelText('Efectivo contado'), '34950,50');
    expect(within(dialog).getByText('Faltan $ 49,50 respecto de lo esperado.')).toBeVisible();
    const submit = within(dialog).getByRole('button', { name: 'Cerrar caja' });
    expect(submit).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Motivo de la diferencia'),
      'Vuelto de más al paciente',
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toEqual([
        { countedCents: 3_495_050, differenceReason: 'Vuelto de más al paciente' },
      ]);
    });
  });

  it('says so when the count is over', async () => {
    const user = userEvent.setup();
    open({ current: session() });

    await user.click(await screen.findByRole('button', { name: 'Cerrar caja' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar la caja' });
    await user.type(within(dialog).getByLabelText('Efectivo contado'), '35100');

    expect(within(dialog).getByText('Sobran $ 100,00 respecto de lo esperado.')).toBeVisible();
    expect(within(dialog).getByLabelText('Motivo de la diferencia')).toBeVisible();
  });

  it('shows the closed registers, and a correction there goes to the open register', async () => {
    const user = userEvent.setup();
    const closedSession = session({
      id: '0190a000-0000-7000-8000-0000000000e8',
      status: 'closed',
      countedCents: money(3_490_000),
      differenceCents: money(-10_000),
      differenceReason: 'Vuelto de más',
      closedAt: '2031-05-11T21:00:00.000Z',
    });
    open({
      current: session(),
      closed: [closedSession],
      routes: {
        [`GET /api/billing/cash/sessions/${closedSession.id}`]: () =>
          jsonResponse({ session: closedSession, entries: [entry()] }),
        [`GET /api/billing/cash/sessions/${IDS.session}`]: () =>
          jsonResponse({ session: session(), entries: [] }),
      },
    });

    expect(await screen.findByRole('heading', { name: 'Cajas anteriores' })).toBeVisible();
    expect(screen.getByText(/diferencia -\$ 100,00/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Ver la caja del/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Caja cerrada' });

    expect(
      within(dialog).getByText(/se corrige con movimientos nuevos en la caja que está abierta/),
    ).toBeVisible();
    expect(within(dialog).getByText('Motivo de la diferencia: Vuelto de más')).toBeVisible();
  });

  it('does not offer to correct a payment of a closed register when none is open', async () => {
    const user = userEvent.setup();
    const closedSession = session({
      id: '0190a000-0000-7000-8000-0000000000e8',
      status: 'closed',
      countedCents: money(0),
      differenceCents: money(0),
    });
    open({
      roles: ['admin'],
      current: null,
      closed: [closedSession],
      routes: {
        [`GET /api/billing/cash/sessions/${closedSession.id}`]: () =>
          jsonResponse({ session: closedSession, entries: [entry()] }),
      },
    });

    await user.click(await screen.findByRole('button', { name: /Ver la caja del/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Caja cerrada' });

    expect(
      await within(dialog).findByText(/Para corregir un pago hay que abrir la caja de la sede/),
    ).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: /Corregir el pago/ })).toBeNull();
  });

  it('keeps the registers apart by location', async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    open({
      locations: [centro, norte],
      current: session(),
      routes: {
        'GET /api/billing/cash/current': (url) => {
          const wanted = new URL(url, 'http://localhost').searchParams.get('locationId');
          asked.push(wanted);
          return jsonResponse({ session: wanted === IDS.location ? session() : null });
        },
      },
    });

    await screen.findByRole('heading', { name: 'Caja de Centro' });
    await user.selectOptions(screen.getByLabelText('Sede'), norte.id);

    expect(await screen.findByText(/La caja de Norte está cerrada/)).toBeVisible();
    expect(asked).toContain(norte.id);
  });

  it('explains when a second desk opened the register first', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        'POST /api/billing/cash/sessions': () => problemResponse(409, 'cash_register_open'),
      },
    });

    await user.type(await screen.findByLabelText('Efectivo con el que empieza'), '0');
    await user.click(screen.getByRole('button', { name: 'Abrir caja' }));

    expect(await screen.findByRole('alert')).toBeVisible();
  });

  it('turns the actions off for an organization in read-only mode', async () => {
    open({ current: session(), readOnly: true });

    expect(await screen.findByRole('button', { name: 'Cerrar caja' })).toBeDisabled();
  });

  it('is not for a role without the cash permission', async () => {
    const app = open({ roles: ['professional'] });

    await waitFor(() => {
      expect(app.requests).toContain('GET /api/auth/me');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText('Efectivo con el que empieza')).toBeNull();
    expect(app.requests).not.toContain('GET /api/billing/cash/current');
  });

  it('has no accessibility violations, with the register open and the closing dialog', async () => {
    const user = userEvent.setup();
    open({ current: session(), entries: [entry()] });

    await user.click(await screen.findByRole('button', { name: 'Cerrar caja' }));
    await screen.findByRole('dialog', { name: 'Cerrar la caja' });

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});
