import {
  money,
  type CalendarEntryDto,
  type ChargeDto,
  type QuoteDto,
} from '@consultorio/contracts';
import { createRoute } from '@tanstack/react-router';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { createRegistry, type FeatureRoute } from '../../app/registry.js';
import { SlotOutlet } from '../../app/slots.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import slots from './slots.js';
import { charge, IDS } from './test-fixtures.js';

const appointment = (status: CalendarEntryDto['status'], readOnly = false) => ({
  entry: {
    id: IDS.appointment,
    patientId: IDS.patient,
    professionalId: IDS.professional,
    locationId: IDS.location,
    appointmentTypeId: '0190a000-0000-7000-8000-0000000000e1',
    startsAt: '2031-05-12T13:00:00.000Z',
    endsAt: '2031-05-12T13:30:00.000Z',
    bufferMinutes: 0,
    status,
    source: 'staff' as const,
    bookedBy: null,
    identityConfirmed: true,
    identityConfirmation: null,
    outOfHours: false,
    seriesId: null,
    seriesIndex: null,
    version: 1,
    patientName: 'Fernández, Lucía',
    typeName: 'Consulta',
    typeColor: null,
    mode: 'in_person' as const,
  } satisfies CalendarEntryDto,
  readOnly,
});

const hostRoute = (status: CalendarEntryDto['status'], readOnly: boolean): FeatureRoute => ({
  mount: 'authed',
  create: (parent) =>
    createRoute({
      getParentRoute: () => parent,
      path: '/fixture-host',
      component: () => {
        const { entry } = appointment(status, readOnly);
        return (
          <section>
            <SlotOutlet slot="appointment-drawer" appointment={entry} readOnly={readOnly} />
          </section>
        );
      },
    }),
});

const quoteOf = (overrides: Partial<QuoteDto> = {}): QuoteDto => ({
  source: 'private',
  priceId: '0190a000-0000-7000-8000-0000000000b9',
  payerPriceId: null,
  payer: null,
  effectiveFrom: '2031-01-01',
  lines: [{ kind: 'service', portion: 'patient', amountCents: money(1_000_000) }],
  totalCents: money(1_000_000),
  patientCents: money(1_000_000),
  payerCents: money(0),
  reasons: [],
  ...overrides,
});

const PAYER = {
  id: IDS.payer,
  payerId: null,
  name: 'OSDE',
  kind: 'prepaga' as const,
  cuit: null,
  active: true,
  deactivatedAt: null,
};

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

interface Setup {
  status?: CalendarEntryDto['status'];
  roles?: Parameters<typeof meFor>[0];
  readOnly?: boolean;
  charges?: ChargeDto[];
  quote?: (url: string) => QuoteDto | null;
  routes?: Record<string, FetchHandler | Response>;
}

function open({
  status = 'checked_in',
  roles = ['reception'],
  readOnly = false,
  charges = [],
  quote = () => quoteOf(),
  routes = {},
}: Setup = {}) {
  const app = renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu'),
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [hostRoute(status, readOnly)] } },
      nav: {},
      slots: { '../features/billing/slots.tsx': { default: slots } },
    }),
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/billing/charges': () => jsonResponse({ charges }),
      'GET /api/billing/price-quote': (url) =>
        jsonResponse({
          appointmentId: IDS.appointment,
          appointmentTypeName: 'Consulta',
          quote: quote(url),
        }),
      'GET /api/billing/payers': () => jsonResponse({ payers: [PAYER], available: [] }),
      ...routes,
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('the charge in the appointment drawer', () => {
  it('only says that the charge starts at check-in, and asks for no price, before the patient arrives', async () => {
    const app = open({ status: 'scheduled' });

    expect(
      await screen.findByText(/El cobro empieza cuando se registra la llegada del paciente/),
    ).toBeVisible();
    expect(app.requests).not.toContain('GET /api/billing/price-quote');
  });

  it('shows the price the system will charge, in pesos, once the patient is checked in', async () => {
    open();

    const lines = await screen.findByRole('list', { name: 'Lo que se va a cobrar' });
    expect(within(lines).getByText('Consulta')).toBeVisible();
    expect(within(lines).getByText('$ 10.000,00')).toBeVisible();
    expect(screen.getByText('El paciente paga').nextElementSibling).toHaveTextContent(
      '$ 10.000,00',
    );
  });

  it('captures the charge with the coverage of the patient, and then shows the charge', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    let charges: ChargeDto[] = [];
    open({
      routes: {
        'GET /api/billing/charges': () => jsonResponse({ charges }),
        'POST /api/billing/charges': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          charges = [charge()];
          return jsonResponse(charge(), 201);
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Generar el cobro' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ appointmentId: IDS.appointment }]);
    });
    expect(await screen.findByRole('list', { name: 'Conceptos del cobro' })).toBeVisible();
    expect(screen.getByText('Pendiente')).toBeVisible();
    expect(screen.getByText('Falta cobrar').nextElementSibling).toHaveTextContent('$ 10.000,00');
  });

  it('asks the quote again for the payer that was chosen, and captures with it', async () => {
    const user = userEvent.setup();
    const quoteUrls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    open({
      quote: (url) => {
        quoteUrls.push(url);
        return url.includes(`payer=${IDS.payer}`)
          ? quoteOf({
              source: 'payer',
              payer: { tenantPayerId: IDS.payer, name: 'OSDE', planName: null },
              lines: [
                { kind: 'payer_coverage', portion: 'payer', amountCents: money(800_000) },
                { kind: 'copago', portion: 'patient', amountCents: money(200_000) },
              ],
              patientCents: money(200_000),
              payerCents: money(800_000),
            })
          : quoteOf();
      },
      routes: {
        'POST /api/billing/charges': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(charge(), 201);
        },
      },
    });

    await screen.findByRole('list', { name: 'Lo que se va a cobrar' });
    await screen.findByRole('option', { name: 'OSDE' });
    await user.selectOptions(screen.getByLabelText('Cobrar según'), IDS.payer);

    expect(await screen.findByText('Cobertura de la obra social')).toBeVisible();
    expect(screen.getByText('Copago')).toBeVisible();
    expect(screen.getByText('El paciente paga').nextElementSibling).toHaveTextContent('$ 2.000,00');
    await user.click(screen.getByRole('button', { name: 'Generar el cobro' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ appointmentId: IDS.appointment, payer: IDS.payer }]);
    });
  });

  it('says why the private price is used for a patient whose payer cannot be priced', async () => {
    open({ quote: () => quoteOf({ reasons: ['payer_without_price'] }) });

    expect(
      await screen.findByText(/La obra social no tiene precio cargado para este turno/),
    ).toBeVisible();
  });

  it('asks for the amount when nothing prices the service, and captures it as typed', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      quote: () => null,
      routes: {
        'POST /api/billing/charges': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(charge({ explicitAmount: true }), 201);
        },
      },
    });

    expect(
      await screen.findByText(/No hay un precio cargado para este tipo de turno/),
    ).toBeVisible();
    const submit = screen.getByRole('button', { name: 'Generar el cobro con este importe' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Importe a cobrar'), '1234,5');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toEqual([{ appointmentId: IDS.appointment, explicitAmountCents: 123_450 }]);
    });
  });

  it('shows the charge that already exists, its flag for review, and does not offer to charge again', async () => {
    const app = open({
      status: 'cancelled',
      charges: [charge({ needsReview: true, reviewReason: 'cancelled' })],
    });

    expect(
      await screen.findByText(/El turno se canceló y este cobro quedó marcado para revisar/),
    ).toBeVisible();
    expect(
      screen.getByText(/decida si corresponde anular el cobro o devolver lo pagado/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Generar el cobro' })).toBeNull();
    expect(app.requests).not.toContain('GET /api/billing/price-quote');
  });

  it('offers only the fee for an appointment that ended without the service', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      status: 'no_show',
      routes: {
        'POST /api/billing/charges': (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(charge(), 201);
        },
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Cobrar el cargo por ausencia o cancelación' }),
    );

    await waitFor(() => {
      expect(bodies).toEqual([{ appointmentId: IDS.appointment }]);
    });
  });

  it('shows the payments, and the amount the payer owes apart from the patient', async () => {
    open({
      status: 'attended',
      roles: ['admin'],
      charges: [
        charge({
          status: 'partially_paid',
          payerCents: money(800_000),
          patientCents: money(200_000),
          paidCents: money(100_000),
          outstandingCents: money(100_000),
          payerName: 'OSDE',
          tenantPayerId: IDS.payer,
          payments: [
            {
              id: IDS.payment,
              chargeId: IDS.charge,
              method: 'debit',
              amountCents: money(100_000),
              creditCents: money(0),
              paidAt: '2031-05-12T13:10:00.000Z',
              recordedBy: IDS.user,
              externalRef: '004512',
              overrideReason: null,
              cashSessionId: null,
              correctsPaymentId: null,
              reversedCents: money(0),
              netCents: money(100_000),
              reversals: [],
            },
          ],
        }),
      ],
    });

    expect(await screen.findByText('Pago parcial')).toBeVisible();
    expect(screen.getByText('Debe la obra social').nextElementSibling).toHaveTextContent(
      '$ 8.000,00',
    );
    expect(screen.getByText('Falta cobrar').nextElementSibling).toHaveTextContent('$ 1.000,00');
    expect(screen.getByText(/Débito · 004512/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Devolver' })).toBeVisible();
  });

  it('shows reception the pay action but not voiding, and says who can void', async () => {
    open({ status: 'attended', roles: ['reception'], charges: [charge()] });

    expect(await screen.findByRole('button', { name: 'Registrar pago' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Anular cobro' })).toBeNull();
    expect(
      screen.getByText('Anular un cobro o devolver un pago lo hacen el dueño o la administración.'),
    ).toBeVisible();
  });

  it('voids a charge for the administration, with a reason, and lets the appointment be charged again', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    let charges = [charge()];
    open({
      status: 'attended',
      roles: ['admin'],
      routes: {
        'GET /api/billing/charges': () => jsonResponse({ charges }),
        [`POST /api/billing/charges/${IDS.charge}/void`]: (_url, init) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          charges = [charge({ status: 'voided', voidReason: 'Cargado dos veces' })];
          return jsonResponse(charges[0]);
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Anular cobro' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Anular el cobro de Lucía Fernández',
    });
    const submit = within(dialog).getByRole('button', { name: 'Anular cobro' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Cargado dos veces');
    await user.click(submit);

    await waitFor(() => {
      expect(bodies).toEqual([{ reason: 'Cargado dos veces' }]);
    });
    expect(await screen.findByText('Hubo un cobro anulado para este turno.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull();
  });

  it('offers no action in an organization that is read-only', async () => {
    open({ status: 'attended', roles: ['admin'], readOnly: true, charges: [charge()] });

    await screen.findByRole('list', { name: 'Conceptos del cobro' });
    expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Anular cobro' })).toBeNull();
  });

  it('has no accessibility violations, with a quote and with a charge', async () => {
    open();
    await screen.findByRole('list', { name: 'Lo que se va a cobrar' });
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('has no accessibility violations for a charge with a review flag and payments', async () => {
    open({
      status: 'attended',
      roles: ['admin'],
      charges: [charge({ needsReview: true, reviewReason: 'no_show', status: 'paid' })],
    });
    await screen.findByText(/marcado para revisar/);
    expect(await a11yViolations(document.body)).toEqual([]);
  });
});
