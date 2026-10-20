import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  DUNNING_RETRY_DAYS,
  PAYMENTS_SIMULATOR_MODES,
  PLAN_DEFAULTS,
  STATEMENT_COLLECTION_DELAY_DAYS,
  SUBSCRIPTION_AUDIT_ACTIONS,
  SUBSCRIPTION_ERRORS,
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
