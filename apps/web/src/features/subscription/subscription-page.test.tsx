import type {
  PlanDto,
  StatementDto,
  SubscriptionDto,
  SubscriptionResponse,
  SubscriptionUsageResponse,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../shared/test/render.js';

const goToProviderPage = vi.hoisted(() => vi.fn());
vi.mock('./domain/provider-page.js', () => ({ goToProviderPage }));
const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('../../shared/lib/download.js', () => ({ downloadBlob }));

const boot = bootFor('Centro Médico Aillu');

const standard: PlanDto = {
  key: 'standard',
  name: 'Plan Profesional',
  currency: 'ARS',
  pricePerProfessionalCents: 1_800_000,
  maxActiveProfessionals: 20,
  whatsappQuotaPerProfessional: 200,
  overageUnitPriceCents: 6_000,
  overageCapDefault: 300,
  overageCapMax: 3_000,
  trialDays: 14,
  graceDays: 7,
};

const subscription = (overrides: Partial<SubscriptionDto> = {}): SubscriptionDto => ({
  status: 'trial',
  plan: standard,
  trialEndsAt: '2026-11-03T15:00:00.000Z',
  graceEndsAt: null,
  paidThrough: null,
  nextTransition: { kind: 'trial_ends', at: '2026-11-03T15:00:00.000Z' },
  authorization: 'none',
  paymentMethodLabel: null,
  nextChargeAt: null,
  authorizedAmountCents: null,
  overageCapMessages: 300,
  activeProfessionals: 2,
  monthlyPriceCents: 3_600_000,
  needsAttention: false,
  ...overrides,
});

const view = (
  overrides: Partial<SubscriptionResponse> & { subscription?: SubscriptionDto | null } = {},
): SubscriptionResponse => ({
  exempt: false,
  subscription: subscription(),
  plan: standard,
  simulated: false,
  ...overrides,
});

const usage = (overrides: Partial<SubscriptionUsageResponse> = {}): SubscriptionUsageResponse => ({
  period: '2026-10',
  professionals: [
    {
      professionalId: '11111111-1111-4111-8111-111111111111',
      name: 'Dra. Lucía Paz',
      count: 230,
      quota: 200,
      remaining: 0,
      overageUnits: 30,
      state: 'exhausted',
    },
    {
      professionalId: '22222222-2222-4222-8222-222222222222',
      name: 'Dr. Mateo Ríos',
      count: 170,
      quota: 200,
      remaining: 30,
      overageUnits: 0,
      state: 'warning',
    },
  ],
  totals: { count: 400, quota: 400, remaining: 30, overageUnits: 30 },
  overage: {
    capMessages: 300,
    capMax: 3_000,
    unitPriceCents: 6_000,
    billableUnits: 30,
    projectedCents: 180_000,
    capReached: false,
  },
  ...overrides,
});

const statement = (overrides: Partial<StatementDto> = {}): StatementDto => ({
  id: '33333333-3333-4333-8333-333333333333',
  period: '2026-09',
  publishedAt: '2026-10-01T12:00:00.000Z',
  collectAfter: '2026-10-04T12:00:00.000Z',
  professionalsCounted: 2,
  baseCents: 2_400_000,
  overageUnits: 30,
  overageCents: 180_000,
  totalCents: 2_580_000,
  collectedCents: 0,
  lines: [
    {
      kind: 'professional',
      professionalId: '11111111-1111-4111-8111-111111111111',
      name: 'Dra. Lucía Paz',
      days: 30,
      daysInPeriod: 30,
      amountCents: 1_800_000,
    },
    {
      kind: 'professional',
      professionalId: '22222222-2222-4222-8222-222222222222',
      name: 'Dr. Mateo Ríos',
      days: 10,
      daysInPeriod: 30,
      amountCents: 600_000,
    },
    {
      kind: 'overage',
      professionalId: '11111111-1111-4111-8111-111111111111',
      name: 'Dra. Lucía Paz',
      quota: 200,
      used: 230,
      units: 30,
      unitPriceCents: 6_000,
      amountCents: 180_000,
    },
  ],
  paymentUrl: null,
  reauthorizationUrl: null,
  ...overrides,
});

interface Opened {
  response?: SubscriptionResponse;
  usage?: SubscriptionUsageResponse;
  statements?: StatementDto[];
  routes?: Record<string, FetchHandler | Response>;
}

function open(options: Opened = {}) {
  return renderApp({
    me: meFor(['owner']),
    boot,
    path: '/subscription',
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/subscription': () => jsonResponse(options.response ?? view()),
      'GET /api/subscription/plans': () => jsonResponse({ plans: [standard] }),
      'GET /api/subscription/usage': () => jsonResponse(options.usage ?? usage()),
      'GET /api/subscription/statements': () =>
        jsonResponse({ statements: options.statements ?? [] }),
      ...options.routes,
    },
  });
}

const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

beforeEach(() => {
  goToProviderPage.mockClear();
  downloadBlob.mockClear();
});

describe('the subscription of the owner', () => {
  it('shows the plan, the state with the date of the next change, and what adding a professional costs', async () => {
    const app = open();

    await heading('Suscripción');
    const plan = await screen.findByRole('region', { name: 'Plan y estado' });
    expect(within(plan).getByText('En prueba')).toBeInTheDocument();
    expect(within(plan).getByText(/La prueba termina el 03\/11\/2026/)).toBeInTheDocument();
    expect(
      within(plan).getByText('$ 18.000,00 por profesional activo, por mes'),
    ).toBeInTheDocument();
    expect(within(plan).getByText('$ 36.000,00')).toBeInTheDocument();
    expect(within(plan).getByText('Todavía no autorizó un medio de pago')).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('is accessible in the state of a trial, with its usage and statements', async () => {
    open({ statements: [statement()] });

    await screen.findByRole('region', { name: 'Resúmenes' });
    await screen.findByText('Dra. Lucía Paz');

    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('says there is no billing for an account that has none, and shows nothing to manage', async () => {
    open({ response: view({ exempt: true, subscription: null, plan: null }) });

    expect(await screen.findByText('Cuenta sin facturación')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autorizar el pago' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Plan y estado' })).not.toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('says the payments are a simulation when they are', async () => {
    open({ response: view({ simulated: true }) });

    expect(await screen.findByText('Pagos de prueba')).toBeInTheDocument();
    expect(screen.getByText(/no se cobra dinero real/)).toBeInTheDocument();
  });

  it('offers to start the subscription when there is none yet, and sends the owner to the provider', async () => {
    const user = userEvent.setup();
    open({
      response: view({ subscription: null }),
      routes: {
        'POST /api/subscription/checkout': () =>
          jsonResponse({ checkoutUrl: 'https://pagos.example/checkout/PRE-1' }),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Autorizar el pago' }));

    await waitFor(() => {
      expect(goToProviderPage).toHaveBeenCalledWith('https://pagos.example/checkout/PRE-1');
    });
  });

  it('shows an active subscription: the payment method, the next charge and when it was paid until', async () => {
    open({
      response: view({
        subscription: subscription({
          status: 'active',
          authorization: 'authorized',
          paymentMethodLabel: 'Visa terminada en 4242',
          nextChargeAt: '2026-11-20T15:00:00.000Z',
          authorizedAmountCents: 3_600_000,
          paidThrough: '2026-11-01T03:00:00.000Z',
          nextTransition: null,
        }),
      }),
    });

    const plan = await screen.findByRole('region', { name: 'Plan y estado' });
    expect(within(plan).getByText('Activa')).toBeInTheDocument();
    expect(within(plan).getByText('Visa terminada en 4242')).toBeInTheDocument();
    expect(within(plan).getByText('$ 36.000,00 el 20/11/2026')).toBeInTheDocument();
    expect(within(plan).getByText('01/11/2026')).toBeInTheDocument();
    expect(
      within(plan).queryByRole('button', { name: 'Autorizar el pago' }),
    ).not.toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('asks for confirmation before cancelling, and shows the cancellation with the way back', async () => {
    const user = userEvent.setup();
    let cancelled = false;
    const active = subscription({
      status: 'active',
      authorization: 'authorized',
      nextTransition: null,
    });
    const cancelling = subscription({
      status: 'cancelling',
      authorization: 'none',
      nextTransition: { kind: 'service_ends', at: '2026-11-01T03:00:00.000Z' },
    });
    open({
      routes: {
        'GET /api/subscription': () =>
          jsonResponse(view({ subscription: cancelled ? cancelling : active })),
        'POST /api/subscription/cancel': () => {
          cancelled = true;
          return jsonResponse(view({ subscription: cancelling }));
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cancelar la suscripción' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/No se borra ningún dato/)).toBeInTheDocument();
    expect(cancelled).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Sí, cancelar' }));

    expect(await screen.findByText('En cancelación')).toBeInTheDocument();
    expect(screen.getByText(/El servicio continúa hasta el 01\/11\/2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retomar la suscripción' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancelar la suscripción' }),
    ).not.toBeInTheDocument();
  });

  it('takes the cancellation back', async () => {
    const user = userEvent.setup();
    let reactivated = false;
    open({
      response: view({
        subscription: subscription({
          status: 'cancelling',
          nextTransition: { kind: 'service_ends', at: '2026-11-01T03:00:00.000Z' },
        }),
      }),
      routes: {
        'POST /api/subscription/reactivate': () => {
          reactivated = true;
          return jsonResponse(
            view({ subscription: subscription({ status: 'active', nextTransition: null }) }),
          );
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Retomar la suscripción' }));

    await waitFor(() => {
      expect(reactivated).toBe(true);
    });
  });

  it('says why a reactivation cannot be done when the authorization is gone', async () => {
    const user = userEvent.setup();
    open({
      response: view({ subscription: subscription({ status: 'cancelling' }) }),
      routes: {
        'POST /api/subscription/reactivate': () =>
          problemResponse(409, 'subscription_reauthorization_required'),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Retomar la suscripción' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Autorice el pago nuevamente/);
  });

  it('shows a payment that is late with the date it becomes read-only, and pays what is overdue', async () => {
    const user = userEvent.setup();
    open({
      response: view({
        subscription: subscription({
          status: 'past_due',
          authorization: 'authorized',
          graceEndsAt: '2026-11-10T15:00:00.000Z',
          nextTransition: { kind: 'read_only_at', at: '2026-11-10T15:00:00.000Z' },
        }),
      }),
      routes: {
        'POST /api/subscription/retry-payment': () =>
          jsonResponse({ paymentUrl: 'https://pagos.example/pay/L-1' }),
      },
    });

    const plan = await screen.findByRole('region', { name: 'Plan y estado' });
    expect(within(plan).getByText('Pago pendiente')).toBeInTheDocument();
    expect(
      within(plan).getByText(/el 10\/11\/2026 la cuenta pasa a solo lectura/),
    ).toBeInTheDocument();
    await user.click(within(plan).getByRole('button', { name: 'Pagar lo adeudado' }));

    await waitFor(() => {
      expect(goToProviderPage).toHaveBeenCalledWith('https://pagos.example/pay/L-1');
    });
  });

  it('shows the read-only state and lets the owner authorize or pay to recover', async () => {
    open({
      response: view({
        subscription: subscription({
          status: 'read_only',
          authorization: 'lost',
          graceEndsAt: '2026-11-10T15:00:00.000Z',
          nextTransition: null,
        }),
      }),
    });

    const plan = await screen.findByRole('region', { name: 'Plan y estado' });
    expect(within(plan).getByText('Solo lectura')).toBeInTheDocument();
    expect(within(plan).getByRole('button', { name: 'Autorizar el pago' })).toBeInTheDocument();
    expect(within(plan).getByRole('button', { name: 'Pagar lo adeudado' })).toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('says the subscription is being reviewed when the provider holds something nobody can tell apart', async () => {
    open({ response: view({ subscription: subscription({ needsAttention: true }) }) });

    expect(await screen.findByText('Estamos revisando su suscripción')).toBeInTheDocument();
  });

  it('shows a refusal in words, not in codes', async () => {
    const user = userEvent.setup();
    open({
      response: view({ subscription: null }),
      routes: {
        'POST /api/subscription/checkout': () =>
          problemResponse(503, 'subscription_payments_unavailable'),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Autorizar el pago' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /No pudimos comunicarnos con Mercado Pago/,
    );
    expect(goToProviderPage).not.toHaveBeenCalled();
  });

  it('changes the plan when the organization has more than one to choose from', async () => {
    const user = userEvent.setup();
    const premium: PlanDto = {
      ...standard,
      key: 'premium',
      name: 'Plan Premium',
      pricePerProfessionalCents: 2_500_000,
    };
    let chosen: unknown;
    open({
      routes: {
        'GET /api/subscription/plans': () => jsonResponse({ plans: [standard, premium] }),
        'POST /api/subscription/plan': (_url, init) => {
          chosen = jsonBody(init);
          return jsonResponse(view({ subscription: subscription({ plan: premium }) }));
        },
      },
    });

    await user.selectOptions(await screen.findByLabelText('Plan'), 'premium');
    await user.click(screen.getByRole('button', { name: 'Cambiar de plan' }));

    await waitFor(() => {
      expect(chosen).toEqual({ planKey: 'premium' });
    });
  });
});

describe('the usage of the month and the overage cap', () => {
  it('shows each professional and the total: sent, quota, what remains and what the overage costs', async () => {
    const app = open();

    const card = await screen.findByRole('region', { name: 'Uso de mensajes de WhatsApp' });
    const items = await within(card).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('Dra. Lucía Paz')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText(/230 de 200 mensajes/)).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Cuota agotada')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Cerca del límite')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText(/Quedan 30 mensajes/)).toBeInTheDocument();
    expect(within(card).getByText(/En total: 400 de 400 mensajes/)).toBeInTheDocument();
    expect(within(card).getByText(/30 mensajes, \$ 1\.800,00/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('carries counts only: no message, no patient', async () => {
    open();

    const card = await screen.findByRole('region', { name: 'Uso de mensajes de WhatsApp' });
    await within(card).findAllByRole('listitem');

    expect(card.textContent).not.toMatch(/paciente|Apellido|@|teléfono/i);
  });

  it('tells the owner when messages beyond the quota go by email', async () => {
    open({
      usage: usage({
        overage: {
          ...usage().overage,
          capMessages: 0,
          billableUnits: 0,
          projectedCents: 0,
          capReached: true,
        },
      }),
    });

    expect(await screen.findByText(/salen por correo electrónico/)).toBeInTheDocument();
  });

  it('saves a cap between zero and the maximum of the plan', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    open({
      routes: {
        'PATCH /api/subscription/overage-cap': (_url, init) => {
          sent = jsonBody(init);
          return jsonResponse({ overageCapMessages: 50 });
        },
      },
    });

    const field = await screen.findByLabelText('Mensajes excedentes por mes');
    expect(field).toHaveValue(300);
    await user.clear(field);
    await user.type(field, '50');
    await user.click(screen.getByRole('button', { name: 'Guardar el tope' }));

    await waitFor(() => {
      expect(sent).toEqual({ overageCapMessages: 50 });
    });
  });

  it('does not send a cap that is above the maximum, negative, empty or not a whole number', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open({
      routes: {
        'PATCH /api/subscription/overage-cap': () => {
          calls += 1;
          return jsonResponse({ overageCapMessages: 1 });
        },
      },
    });

    const field = await screen.findByLabelText('Mensajes excedentes por mes');
    for (const value of ['3001', '-1', '1.5', '']) {
      await user.clear(field);
      if (value !== '') await user.type(field, value);
      await user.click(screen.getByRole('button', { name: 'Guardar el tope' }));
      expect(
        await screen.findByText('Ingrese un número entero entre 0 y 3000.'),
      ).toBeInTheDocument();
    }

    expect(calls).toBe(0);
    expect(screen.getByText(/Nunca es ilimitado/)).toBeInTheDocument();
  });

  it('shows the refusal of the server when the cap is above the maximum of the plan', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        'PATCH /api/subscription/overage-cap': () =>
          problemResponse(422, 'subscription_overage_cap_too_high'),
      },
    });

    await screen.findByLabelText('Mensajes excedentes por mes');
    await user.click(screen.getByRole('button', { name: 'Guardar el tope' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/supera el máximo/);
  });

  it('is accessible', async () => {
    open();
    await screen.findByLabelText('Mensajes excedentes por mes');

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});

describe('the statements', () => {
  it('says there are none yet', async () => {
    open();

    expect(await screen.findByText(/Todavía no hay resúmenes/)).toBeInTheDocument();
  });

  it('lists a statement with its total, the dates and the lines it bills', async () => {
    const user = userEvent.setup();
    open({ statements: [statement()] });

    const item = await screen.findByRole('article', { name: 'Resumen de septiembre de 2026' });
    expect(within(item).getByText('Total: $ 25.800,00')).toBeInTheDocument();
    expect(within(item).getByText('Pendiente de cobro')).toBeInTheDocument();
    expect(within(item).getByText(/Publicado el 01\/10\/2026/)).toBeInTheDocument();
    expect(within(item).getByText(/Se cobra a partir del 04\/10\/2026/)).toBeInTheDocument();
    expect(within(item).queryByText(/Dr. Mateo Ríos: 10 de 30 días/)).not.toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Ver el detalle' }));
    expect(within(item).getByText('Dr. Mateo Ríos: 10 de 30 días')).toBeInTheDocument();
    expect(
      within(item).getByText(
        /Dra. Lucía Paz: 30 mensajes excedentes de 230 enviados \(cuota 200\)/,
      ),
    ).toBeInTheDocument();
    expect(within(item).getByText('Suscripción')).toBeInTheDocument();
    expect(await a11yViolations(document.body)).toEqual([]);
  });

  it('shows a statement that was collected in full', async () => {
    open({ statements: [statement({ collectedCents: 2_580_000 })] });

    expect(await screen.findByText('Cobrado por completo')).toBeInTheDocument();
  });

  it('downloads the statement as a document', async () => {
    const user = userEvent.setup();
    let requested = '';
    open({
      statements: [statement()],
      routes: {
        'GET /api/subscription/statements/33333333-3333-4333-8333-333333333333/document': (url) => {
          requested = url;
          return new Response(new Blob(['%PDF-1.7']), {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="resumen-2026-09.pdf"',
            },
          });
        },
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Descargar el resumen de septiembre de 2026' }),
    );

    await waitFor(() => {
      expect(downloadBlob).toHaveBeenCalledTimes(1);
    });
    expect(requested).toContain('/subscription/statements/33333333');
    expect(downloadBlob.mock.calls[0]?.[1]).toBe('resumen-2026-09.pdf');
  });

  it('offers the link for the difference when the provider would not change the amount', async () => {
    const user = userEvent.setup();
    open({ statements: [statement({ paymentUrl: 'https://pagos.example/pay/L-9' })] });

    expect(
      await screen.findByText(/no permite cambiar el monto del cobro automático/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pagar la diferencia' }));

    expect(goToProviderPage).toHaveBeenCalledWith('https://pagos.example/pay/L-9');
  });

  it('asks the owner to authorize the new amount when the provider needs it', async () => {
    const user = userEvent.setup();
    open({
      statements: [statement({ reauthorizationUrl: 'https://pagos.example/checkout/PRE-1' })],
    });

    expect(
      await screen.findByText(/necesita que autorice nuevamente el monto/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Autorizar el nuevo monto' }));

    expect(goToProviderPage).toHaveBeenCalledWith('https://pagos.example/checkout/PRE-1');
  });
});

describe('who can open it', () => {
  it.each([['admin'], ['professional'], ['reception']] as const)(
    'shows %s no billing at all: not the plan, not the usage, not the statements',
    async (role) => {
      const app = renderApp({
        me: meFor([role]),
        boot,
        path: '/subscription',
        routes: { 'GET /api/worklist/count': () => jsonResponse({ open: 0 }) },
      });

      expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
      expect(app.requests.filter((request) => request.includes('/subscription'))).toEqual([]);
      expect(screen.queryByText('Plan y estado')).not.toBeInTheDocument();
    },
  );
});
