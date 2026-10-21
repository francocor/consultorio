import type { OperatorSubscriptionDto, OperatorTenantDto } from '@consultorio/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { renderInRouter } from '../../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../../shared/test/render.js';

import { SubscriptionsTab } from './SubscriptionsTab.js';

const TENANT_A = '0190a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0190a000-0000-7000-8000-0000000000b2';

const tenant = (id: string, name: string): OperatorTenantDto => ({
  id,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  name,
  status: 'active',
  isDemo: false,
  country: 'AR',
  createdAt: '2026-08-01T12:00:00.000Z',
});

const subscription = (
  overrides: Partial<OperatorSubscriptionDto> = {},
): OperatorSubscriptionDto => ({
  id: TENANT_A,
  status: 'active',
  planKey: 'standard',
  trialEndsAt: '2026-08-15T15:00:00.000Z',
  graceEndsAt: null,
  paidThrough: '2026-11-01T03:00:00.000Z',
  dunningStep: 0,
  authorization: 'authorized',
  overageCapMessages: 300,
  attentionReason: null,
  surplusFlags: 0,
  ...overrides,
});

/** The JSON body a request carried. */
const sentBody = (init: RequestInit): unknown =>
  JSON.parse(typeof init.body === 'string' ? init.body : '{}') as unknown;

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  subscriptions: OperatorSubscriptionDto[],
  routes: Parameters<typeof renderInRouter>[1] extends infer O
    ? O extends { routes?: infer R }
      ? R
      : never
    : never = {},
) {
  const app = renderInRouter(<SubscriptionsTab />, {
    routes: {
      'GET /api/operator/subscriptions': () => jsonResponse({ subscriptions }),
      'GET /api/operator/tenants': () =>
        jsonResponse({
          tenants: [tenant(TENANT_A, 'Centro Médico Aillu'), tenant(TENANT_B, 'Consultorio Sur')],
        }),
      ...routes,
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('the subscriptions tab of the operator console', () => {
  it('lists each organization with its state, plan and counters', async () => {
    open([
      subscription(),
      subscription({
        id: TENANT_B,
        status: 'past_due',
        graceEndsAt: '2026-11-10T15:00:00.000Z',
        authorization: 'lost',
        overageCapMessages: 0,
      }),
    ]);

    const list = await screen.findByRole('list', { name: 'Suscripciones de las organizaciones' });
    const [first, second] = within(list).getAllByRole('article');
    expect(within(first as HTMLElement).getByText('Centro Médico Aillu')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('Activa')).toBeInTheDocument();
    expect(first).toHaveTextContent('standard');
    expect(first).toHaveTextContent('Autorizada');
    expect(first).toHaveTextContent('Pagado hasta 01/11/2026');
    expect(first).toHaveTextContent('Sin alertas');
    expect(within(second as HTMLElement).getByText('Pago pendiente')).toBeInTheDocument();
    expect(second).toHaveTextContent('Solo lectura el 10/11/2026');
    expect(second).toHaveTextContent('Perdida');
    expect(second).toHaveTextContent('Tope de excedentes: 0');
  });

  it('flags the parked subscriptions and the duplicate payments that wait for a look', async () => {
    open([subscription({ attentionReason: 'ambiguous_preapproval', surplusFlags: 2 })]);

    const article = await screen.findByRole('article', { name: 'Centro Médico Aillu' });
    expect(article).toHaveTextContent('Requiere revisión: más de una autorización posible');
    expect(article).toHaveTextContent('2 pagos duplicados sin revisar');
  });

  it('shows the usage counts of one organization on demand, and nothing that names a person', async () => {
    const user = userEvent.setup();
    open([subscription()], {
      'GET /api/operator/usage': () =>
        jsonResponse({
          id: TENANT_A,
          periods: [
            {
              period: '2026-10',
              professionals: [
                {
                  professionalId: '11111111-1111-4111-8111-111111111111',
                  activeDays: 20,
                  messages: 230,
                },
              ],
            },
          ],
        }),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Ver el uso de Centro Médico Aillu' }),
    );

    const usage = await screen.findByRole('region', { name: 'Uso de Centro Médico Aillu' });
    expect(usage).toHaveTextContent('Mes de octubre de 2026');
    expect(usage).toHaveTextContent('Profesional 11111111: 20 días activo, 230 mensajes');
    expect(usage).toHaveTextContent('ni mensajes ni pacientes');
    expect(usage.textContent).not.toMatch(/@|paciente [A-Z]/);
  });

  it('lets the operator pick up a parked subscription only with a reason and a confirmation, and says who decided in the request', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    open([subscription({ attentionReason: 'identity_mismatch' })], {
      [`POST /api/operator/tenants/${TENANT_A}/subscription/resolve-parked`]: (_url, init) => {
        sent.push(sentBody(init));
        return jsonResponse({ status: 'resolved', was: 'identity_mismatch' });
      },
    });

    await user.click(
      await screen.findByRole('button', {
        name: 'Dejar seguir la suscripción de Centro Médico Aillu',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Dejar seguir' });
    expect(submit).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Motivo'),
      'Lo miré en el panel del proveedor y no hay cobros.',
    );
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(submit);

    await vi.waitFor(() => {
      expect(sent).toEqual([{ reason: 'Lo miré en el panel del proveedor y no hay cobros.' }]);
    });
  });

  it('lists the payments without a payer, refunds one with a token made once, and marks a surplus as looked at', async () => {
    const user = userEvent.setup();
    const refunds: { token: string; amountCents: number; confirmed: boolean }[] = [];
    const payment = {
      id: '0190a000-0000-7000-8000-0000000000c3',
      purpose: 'charge' as const,
      amountCents: 1_800_000,
      status: 'approved',
      refundedCents: 0,
      period: '2026-10',
      surplus: true,
      surplusReviewedAt: null,
      createdAt: '2026-10-20T15:00:00.000Z',
    };
    open([subscription({ surplusFlags: 1 })], {
      [`GET /api/operator/tenants/${TENANT_A}/subscription/payments`]: () =>
        jsonResponse({ payments: [payment] }),
      [`POST /api/operator/tenants/${TENANT_A}/subscription/payments/${payment.id}/refund`]: (
        _url,
        init,
      ) => {
        refunds.push(sentBody(init) as (typeof refunds)[number]);
        return jsonResponse({ status: 'refunded', amountCents: 500_000 });
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Ver los pagos de Centro Médico Aillu' }),
    );
    const panel = await screen.findByRole('region', { name: 'Pagos de Centro Médico Aillu' });
    expect(panel).toHaveTextContent('$ 18.000,00');
    expect(panel).toHaveTextContent('Pago de más, sin revisar');
    expect(panel.textContent).not.toMatch(/@|PAY-/);

    await user.click(within(panel).getByRole('button', { name: 'Reembolsar' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Importe a devolver/), '5000');
    await user.type(
      within(dialog).getByLabelText('Motivo'),
      'El cliente pagó dos veces el mismo mes.',
    );
    const submit = within(dialog).getByRole('button', { name: 'Reembolsar' });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(submit);

    await vi.waitFor(() => {
      expect(refunds).toHaveLength(1);
    });
    expect(refunds[0]).toMatchObject({ amountCents: 500_000, confirmed: true });
    expect(refunds[0]?.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says there are no subscriptions when there are none', async () => {
    open([]);

    expect(await screen.findByText('Todavía no hay suscripciones.')).toBeInTheDocument();
  });

  it('says what went wrong when the list cannot be read', async () => {
    open([], { 'GET /api/operator/subscriptions': () => problemResponse(500, 'internal_error') });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = open([
      subscription(),
      subscription({ id: TENANT_B, attentionReason: 'unexpected_state' }),
    ]);
    await screen.findByRole('list', { name: 'Suscripciones de las organizaciones' });

    expect(await a11yViolations(container)).toEqual([]);
  });
});
