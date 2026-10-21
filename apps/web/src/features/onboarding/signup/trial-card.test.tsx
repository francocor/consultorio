import type { PlanDto, SubscriptionDto, SubscriptionResponse } from '@consultorio/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../shared/test/fixtures.js';
import { renderApp } from '../../../shared/test/render-app.js';
import { jsonResponse, problemResponse, type FetchHandler } from '../../../shared/test/render.js';
import { stateFor } from '../fixtures.js';

const goToProviderPage = vi.hoisted(() => vi.fn());
vi.mock('../../subscription/domain/provider-page.js', () => ({ goToProviderPage }));

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

const trial = (overrides: Partial<SubscriptionDto> = {}): SubscriptionDto => ({
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
  activeProfessionals: 1,
  monthlyPriceCents: 1_800_000,
  needsAttention: false,
  ...overrides,
});

const view = (overrides: Partial<SubscriptionResponse> = {}): SubscriptionResponse => ({
  exempt: false,
  subscription: trial(),
  plan: standard,
  simulated: false,
  ...overrides,
});

function openWizard(
  options: { subscription?: FetchHandler | Response; me?: ReturnType<typeof meFor> } = {},
) {
  const answer = options.subscription ?? (() => jsonResponse(view()));
  return renderApp({
    me: options.me ?? meFor(['owner']),
    boot: bootFor('Centro Médico Aillu'),
    path: '/onboarding',
    routes: {
      'GET /api/onboarding/state': () => jsonResponse(stateFor()),
      'GET /api/subscription': answer,
    },
  });
}

beforeEach(() => {
  goToProviderPage.mockReset();
});

describe('the trial in the setup wizard', () => {
  it('says when the trial ends and what happens then, and the wizard goes on', async () => {
    const app = openWizard();

    expect(await screen.findByRole('heading', { name: 'Su período de prueba' })).toBeVisible();
    expect(screen.getByText(/Termina el 03\/11\/2026/)).toBeVisible();
    expect(screen.getByText(/tiene 7 días más para regularizarlo/)).toBeVisible();
    expect(screen.getByText(/pasa a solo lectura/)).toBeVisible();
    // The wizard is still there: nothing waits for the payment.
    expect(await screen.findByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('takes the owner to the page of the provider to authorize the payment now', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    // The checkout answers with the address of the provider's page.
    renderApp({
      me: meFor(['owner']),
      boot: bootFor('Centro Médico Aillu'),
      path: '/onboarding',
      routes: {
        'GET /api/onboarding/state': () => jsonResponse(stateFor()),
        'GET /api/subscription': () => jsonResponse(view()),
        'POST /api/subscription/checkout': () => {
          calls.push('checkout');
          return jsonResponse({ checkoutUrl: 'https://pagos.example.test/checkout/abc' });
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Autorizar el pago ahora' }));

    await waitFor(() => {
      expect(goToProviderPage).toHaveBeenCalledWith('https://pagos.example.test/checkout/abc');
    });
    expect(calls).toEqual(['checkout']);
  });

  it('keeps the wizard and says the payment can wait when the provider is down', async () => {
    const user = userEvent.setup();
    renderApp({
      me: meFor(['owner']),
      boot: bootFor('Centro Médico Aillu'),
      path: '/onboarding',
      routes: {
        'GET /api/onboarding/state': () => jsonResponse(stateFor()),
        'GET /api/subscription': () => jsonResponse(view()),
        'POST /api/subscription/checkout': () =>
          problemResponse(503, 'subscription_payments_unavailable'),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Autorizar el pago ahora' }));

    expect(await screen.findByText(/completar el pago más tarde/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ir a Suscripción' })).toHaveAttribute(
      'href',
      '/subscription',
    );
    expect(goToProviderPage).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
  });

  it('only says the payment is authorized once it is, and offers nothing more', async () => {
    openWizard({
      subscription: () =>
        jsonResponse(view({ subscription: trial({ authorization: 'authorized' }) })),
    });

    expect(await screen.findByText(/Ya autorizó el pago/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Autorizar el pago ahora' }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['an organization past its trial', view({ subscription: trial({ status: 'active' }) })],
    ['an organization with no billing', view({ exempt: true, subscription: null, plan: null })],
  ])('shows nothing for %s', async (_name, response) => {
    openWizard({ subscription: () => jsonResponse(response) });

    expect(await screen.findByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Su período de prueba' })).not.toBeInTheDocument();
  });

  it('never waits for the subscription: if it cannot be read the wizard shows alone', async () => {
    openWizard({ subscription: () => problemResponse(500, 'internal_error') });

    expect(await screen.findByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Su período de prueba' })).not.toBeInTheDocument();
  });

  it('asks nothing for a person who does not manage the billing', async () => {
    const app = openWizard({ me: meFor(['admin'], { grants: ['onboarding.manage'] }) });

    expect(await screen.findByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
    expect(app.requests.filter((request) => request.includes('/subscription'))).toEqual([]);
  });
});
