import { describe, expect, it } from 'vitest';

import {
  describePaymentsGatewayContract,
  type GatewayMode,
  type PaymentsGatewayHarness,
} from '../payments-gateway.contract.js';

import { createFakePaymentsGateway } from './index.js';

const NOW = new Date('2026-10-20T15:00:00.000Z');

function harnessFor(idempotent: boolean): PaymentsGatewayHarness {
  const fake = createFakePaymentsGateway({ idempotent, clock: () => NOW });
  return {
    gateway: fake,
    secret: fake.secret,
    now: () => NOW,
    setMode: (mode: GatewayMode) => {
      fake.setMode(mode);
      return Promise.resolve();
    },
    authorize: (id) => {
      fake.authorize(id);
      return Promise.resolve();
    },
    chargeCycle: (id, outcome) => {
      fake.chargeCycle(id, outcome);
      return Promise.resolve();
    },
    payLink: (id) => {
      fake.payLink(id);
      return Promise.resolve();
    },
    sign: (body, ts) => Promise.resolve(fake.sign(body, ts)),
    hold: (options) => fake.hold(options),
  };
}

// The same suite against both kinds of provider: one that honours a repeated key and one that does not.
describePaymentsGatewayContract({
  name: 'in-memory fake, honours the key',
  make: () => Promise.resolve(harnessFor(true)),
});
describePaymentsGatewayContract({
  name: 'in-memory fake, does not honour the key',
  make: () => Promise.resolve(harnessFor(false)),
});

describe('the in-memory payments gateway', () => {
  it('says what it is: simulated, and whether it honours the key', () => {
    expect(createFakePaymentsGateway()).toMatchObject({
      simulated: true,
      honoursIdempotencyKey: true,
    });
    expect(createFakePaymentsGateway({ idempotent: false }).honoursIdempotencyKey).toBe(false);
  });

  it('lets the webhook modes of the local simulator through as plain operation: it delivers no webhooks', async () => {
    const fake = createFakePaymentsGateway();
    for (const mode of ['duplicate_events', 'out_of_order'] as const) {
      fake.setMode(mode);

      const result = await fake.createPreapproval(
        {
          externalReference: `sub|org|${mode}`,
          payerEmail: 'duena@clinica.example',
          reason: 'Plan',
          amountCents: 100_000,
          currency: 'ARS',
          backUrl: 'https://clinica.consultorio.test/subscription',
        },
        `key-${mode}`,
      );

      expect(result.status, mode).toBe('created');
    }
  });

  it('applies a pending amount only when the payer authorizes it again', async () => {
    const fake = createFakePaymentsGateway();
    const request = {
      externalReference: 'sub|org|reauth',
      payerEmail: 'duena@clinica.example',
      reason: 'Plan',
      amountCents: 100_000,
      currency: 'ARS' as const,
      backUrl: 'https://clinica.consultorio.test/subscription',
    };
    const created = await fake.createPreapproval(request, 'key-reauth');
    if (created.status !== 'created') throw new Error('not created');
    const { preapprovalId } = created.preapproval;
    fake.authorize(preapprovalId);
    fake.setMode('reauthorize');

    const asked = await fake.updatePreapprovalAmount(
      { preapprovalId, amountCents: 250_000, externalReference: request.externalReference },
      'key-amount',
    );
    expect(asked.status).toBe('reauthorization_required');
    expect(fake.preapprovals()[0]?.amountCents).toBe(100_000);

    fake.authorize(preapprovalId);

    expect(fake.preapprovals()[0]?.amountCents).toBe(250_000);
  });

  it('forgets everything on reset and goes back to ok', async () => {
    const fake = createFakePaymentsGateway();
    await fake.createPaymentLink(
      {
        externalReference: 'stmt|org|reset',
        payerEmail: 'duena@clinica.example',
        title: 'Resumen',
        amountCents: 100_000,
        currency: 'ARS',
        backUrl: 'https://clinica.consultorio.test/subscription',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      'key-reset',
    );
    fake.setMode('down');
    expect(fake.paymentLinks()).toHaveLength(1);

    fake.reset();

    expect(fake.paymentLinks()).toEqual([]);
    expect(fake.mode()).toBe('ok');
  });
});
