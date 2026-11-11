import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import { isPlatformAuditAction } from './operator.js';
import {
  DUNNING_RETRY_DAYS,
  OPERATOR_BILLING_REASON_MAX,
  OPERATOR_BILLING_REASON_MIN,
  OperatorPaymentsResponse,
  OperatorRefundRequest,
  OperatorResolveParkedRequest,
  OperatorSurplusReviewRequest,
  PAYMENTS_SIMULATOR_MODES,
  PLAN_DEFAULTS,
  STATEMENT_COLLECTION_DELAY_DAYS,
  SUBSCRIPTION_AUDIT_ACTIONS,
  SUBSCRIPTION_ERRORS,
  SUBSCRIPTION_PLATFORM_AUDIT_ACTIONS,
  SUBSCRIPTION_STATUSES,
  TENANT_STATUS_OF_SUBSCRIPTION,
} from './subscriptions.js';

describe('subscription catalogues', () => {
  it('has the six states of the lifecycle in the order the design draws them', () => {
    expect([...SUBSCRIPTION_STATUSES]).toEqual([
      'trial',
      'active',
      'past_due',
      'read_only',
      'cancelling',
      'cancelled',
    ]);
  });

  it('derives the state of the tenant from the state of the subscription (design section 7)', () => {
    expect(TENANT_STATUS_OF_SUBSCRIPTION).toEqual({
      trial: 'active',
      active: 'active',
      past_due: 'active',
      read_only: 'read_only',
      cancelling: 'active',
      cancelled: 'cancelled',
    });
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(TENANT_STATUS_OF_SUBSCRIPTION[status], status).toBeDefined();
    }
  });

  it('keeps the numbers that are certain from the design: trial, grace, quota and the dunning days', () => {
    expect(PLAN_DEFAULTS).toEqual({
      trialDays: 14,
      graceDays: 7,
      whatsappQuotaPerProfessional: 200,
    });
    expect([...DUNNING_RETRY_DAYS]).toEqual([1, 3, 5]);
    expect(STATEMENT_COLLECTION_DELAY_DAYS).toBe(3);
  });

  it('names the modes of the payments simulator, the ones of the local Mercado Pago included', () => {
    expect([...PAYMENTS_SIMULATOR_MODES]).toEqual([
      'ok',
      'down',
      'refuse_amount_change',
      'duplicate_events',
      'out_of_order',
      'lose_answer',
      'reauthorize',
    ]);
  });

  it('registers its audit actions in the shared catalogue, once each', () => {
    expect(SUBSCRIPTION_AUDIT_ACTIONS).toEqual([
      'subscription.created',
      'subscription.plan_changed',
      'subscription.state_changed',
      'subscription.cap_changed',
      'subscription.surplus_flagged',
      'subscription.refunded',
      'subscription.preapproval_cancelled',
      'subscription.parked_resolved',
      'subscription.surplus_reviewed',
    ]);
    for (const action of SUBSCRIPTION_AUDIT_ACTIONS) {
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('has an error catalog that is part of the API catalog', () => {
    // Typed as a plain catalog: once the track fills it in, it has its own literal shape.
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> =
      SUBSCRIPTION_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

describe('what the operator decides about billing (JD-S6 R1)', () => {
  const token = '0192f3a0-6b2c-7000-8000-0000000000aa';
  const reason = 'El pago esta duplicado, lo verifique en el panel.';

  it('writes the decisions of the operator in the platform trail as well', () => {
    for (const action of SUBSCRIPTION_PLATFORM_AUDIT_ACTIONS) {
      expect(isPlatformAuditAction(action), action).toBe(true);
      expect(SUBSCRIPTION_AUDIT_ACTIONS as readonly string[], action).toContain(action);
    }
  });

  it('refuses a refund without the confirmation, a token, a real reason or a positive amount', () => {
    const valid = { amountCents: 500_000, reason, token, confirmed: true };

    expect(OperatorRefundRequest.safeParse(valid).success).toBe(true);
    for (const bad of [
      { ...valid, confirmed: false },
      { ...valid, token: 'abc' },
      { ...valid, reason: 'corto' },
      { ...valid, amountCents: 0 },
      { ...valid, amountCents: 1.5 },
      { amountCents: 500_000, reason, confirmed: true },
      { ...valid, extra: 1 },
    ]) {
      expect(OperatorRefundRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('asks for a reason of a sensible length when a parked subscription is let go or a surplus is reviewed', () => {
    for (const schema of [OperatorResolveParkedRequest, OperatorSurplusReviewRequest]) {
      expect(schema.safeParse({ reason }).success).toBe(true);
      expect(
        schema.safeParse({ reason: 'x'.repeat(OPERATOR_BILLING_REASON_MIN - 1) }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ reason: 'x'.repeat(OPERATOR_BILLING_REASON_MAX + 1) }).success,
      ).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('lists payments with amounts and flags and nothing that names a payer or the provider', () => {
    const payment = {
      id: token,
      purpose: 'charge',
      amountCents: 1_800_000,
      status: 'approved',
      refundedCents: 0,
      period: '2026-10',
      surplus: true,
      surplusReviewedAt: null,
      createdAt: '2026-10-20T15:00:00.000Z',
    };

    expect(OperatorPaymentsResponse.safeParse({ payments: [payment] }).success).toBe(true);
    expect(
      OperatorPaymentsResponse.safeParse({ payments: [{ ...payment, providerPaymentId: 'PAY-1' }] })
        .success,
    ).toBe(false);
  });
});
