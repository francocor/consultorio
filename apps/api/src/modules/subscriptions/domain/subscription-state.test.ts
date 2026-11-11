import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '@consultorio/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSITIONS,
  derivedTenantStatus,
  transition,
  type SubscriptionEvent,
  type SubscriptionFacts,
} from './subscription-state.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const GRACE_DAYS = 7;

function facts(
  status: SubscriptionStatus,
  overrides: Partial<SubscriptionFacts> = {},
): SubscriptionFacts {
  return {
    status,
    trialEndsAt: at(-1),
    graceEndsAt: status === 'past_due' || status === 'read_only' ? at(3) : null,
    paidThrough: status === 'active' || status === 'cancelling' ? at(10) : null,
    authorized: status === 'active',
    ...overrides,
  };
}

const run = (state: SubscriptionFacts, event: SubscriptionEvent, now = NOW) =>
  transition(state, event, { now, graceDays: GRACE_DAYS });

describe('the subscription state machine: what a provider-confirmed event does', () => {
  it('moves a trial to active when the provider confirms the authorization', () => {
    const result = run(facts('trial', { trialEndsAt: at(5) }), { type: 'authorization_confirmed' });

    expect(result).toMatchObject({ changed: true, from: 'trial', to: 'active' });
    expect(result.tenantStatus).toBe('active');
  });

  it('leaves a past due or read-only subscription alone when only the authorization is confirmed: the debt is not paid', () => {
    for (const status of ['past_due', 'read_only'] as const) {
      const result = run(facts(status), { type: 'authorization_confirmed' });
      expect(result, status).toMatchObject({ changed: false, to: status });
    }
  });

  it('settles a past due or read-only subscription only when the provider confirms an approved payment', () => {
    for (const status of ['past_due', 'read_only'] as const) {
      const result = run(facts(status), { type: 'payment_approved' });

      expect(result, status).toMatchObject({ changed: true, from: status, to: 'active' });
      expect(result.graceEndsAt).toBeNull();
      expect(result.tenantStatus).toBe('active');
    }
  });

  it('activates a trial that is paid by a payment link, with no authorization', () => {
    expect(run(facts('trial', { trialEndsAt: at(5) }), { type: 'payment_approved' })).toMatchObject(
      { changed: true, to: 'active' },
    );
  });

  it('starts the grace period at the failure: past due, with the read-only date seven days later', () => {
    const failedAt = at(-2);

    const result = run(facts('active'), { type: 'payment_rejected', at: failedAt });

    expect(result).toMatchObject({ changed: true, from: 'active', to: 'past_due' });
    expect(result.graceEndsAt).toEqual(new Date(failedAt.getTime() + GRACE_DAYS * DAY));
    expect(result.tenantStatus).toBe('active');
  });

  it('does not restart the grace on a second failure, nor touch a trial or a cancelling subscription', () => {
    const pastDue = facts('past_due', { graceEndsAt: at(2) });
    expect(run(pastDue, { type: 'payment_rejected', at: at(-0.5) })).toMatchObject({
      changed: false,
      graceEndsAt: at(2),
    });
    expect(run(facts('cancelling'), { type: 'payment_rejected', at: NOW }).changed).toBe(false);
    expect(run(facts('trial'), { type: 'payment_rejected', at: NOW }).changed).toBe(false);
  });

  it('keeps a cancelling subscription cancelling when a payment is approved', () => {
    expect(run(facts('cancelling'), { type: 'payment_approved' })).toMatchObject({
      changed: false,
      to: 'cancelling',
    });
  });
});

describe('the subscription state machine: what a date does', () => {
  it('moves a trial that ended with no subscription to past due, with the grace counted from the end of the trial', () => {
    const trialEndsAt = at(-1);

    const result = run(facts('trial', { trialEndsAt }), { type: 'trial_ended' });

    expect(result).toMatchObject({ changed: true, from: 'trial', to: 'past_due' });
    expect(result.graceEndsAt).toEqual(new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY));
  });

  it('does not end a trial before its date', () => {
    const result = run(facts('trial', { trialEndsAt: at(2) }), { type: 'trial_ended' });

    expect(result).toMatchObject({ changed: false, to: 'trial', reason: 'not_due' });
  });

  it('turns past due into read-only when the grace has ended, and not before', () => {
    const due = run(facts('past_due', { graceEndsAt: at(-0.1) }), { type: 'grace_expired' });
    const early = run(facts('past_due', { graceEndsAt: at(0.1) }), { type: 'grace_expired' });

    expect(due).toMatchObject({ changed: true, from: 'past_due', to: 'read_only' });
    expect(due.tenantStatus).toBe('read_only');
    expect(early).toMatchObject({ changed: false, to: 'past_due', reason: 'not_due' });
  });

  it('moves an active subscription whose coverage ended and whose authorization is gone to past due', () => {
    const lost = facts('active', {
      authorized: false,
      paidThrough: at(-2),
      trialEndsAt: at(-20),
    });

    const result = run(lost, { type: 'coverage_ended' });

    expect(result).toMatchObject({ changed: true, to: 'past_due' });
    expect(result.graceEndsAt).toEqual(new Date(at(-2).getTime() + GRACE_DAYS * DAY));
  });

  it('keeps an active subscription active while it is covered or authorized', () => {
    expect(
      run(facts('active', { authorized: false, paidThrough: at(2) }), { type: 'coverage_ended' })
        .changed,
    ).toBe(false);
    expect(
      run(facts('active', { authorized: true, paidThrough: at(-2) }), { type: 'coverage_ended' })
        .changed,
    ).toBe(false);
  });

  it('ends a cancelling subscription at the end of the paid period and says to announce it', () => {
    const due = run(facts('cancelling', { paidThrough: at(-1) }), { type: 'period_ended' });
    const early = run(facts('cancelling', { paidThrough: at(4) }), { type: 'period_ended' });

    expect(due).toMatchObject({
      changed: true,
      from: 'cancelling',
      to: 'cancelled',
      publishCancelled: true,
    });
    expect(due.tenantStatus).toBe('cancelled');
    expect(early).toMatchObject({ changed: false, publishCancelled: false });
  });

  it('never ends a cancelling subscription while the provider may still be charging it (JD-S6 R1, C1)', () => {
    const due = facts('cancelling', { paidThrough: at(-1) });

    expect(run({ ...due, providerHolds: true }, { type: 'period_ended' })).toMatchObject({
      changed: false,
      to: 'cancelling',
      publishCancelled: false,
      reason: 'not_allowed',
    });
    expect(run({ ...due, providerHolds: false }, { type: 'period_ended' })).toMatchObject({
      changed: true,
      to: 'cancelled',
    });
  });
});

describe('the subscription state machine: what the owner does', () => {
  it('cancels at the end of the paid period and keeps the service until then', () => {
    const result = run(facts('active'), { type: 'cancel_requested' });

    expect(result).toMatchObject({ changed: true, from: 'active', to: 'cancelling' });
    expect(result.paidThrough).toEqual(at(10));
    expect(result.tenantStatus).toBe('active');
  });

  it('cancels a trial at the end of the trial', () => {
    const result = run(facts('trial', { trialEndsAt: at(6) }), { type: 'cancel_requested' });

    expect(result).toMatchObject({ changed: true, to: 'cancelling' });
    expect(result.paidThrough).toEqual(at(6));
  });

  it('cancels at once when nothing is paid: a past due subscription has no period left', () => {
    const result = run(facts('past_due', { paidThrough: at(-5) }), { type: 'cancel_requested' });

    expect(result.to).toBe('cancelling');
    expect(result.paidThrough).toEqual(NOW);
  });

  it('refuses to cancel what is cancelled, and does nothing for what is already cancelling', () => {
    expect(run(facts('cancelled'), { type: 'cancel_requested' })).toMatchObject({
      changed: false,
      reason: 'not_allowed',
    });
    expect(run(facts('cancelling'), { type: 'cancel_requested' }).changed).toBe(false);
  });

  it('reactivates a cancelling subscription before the period ends, back to active when it is still authorized', () => {
    const result = run(facts('cancelling', { authorized: true }), { type: 'reactivated' });

    expect(result).toMatchObject({ changed: true, from: 'cancelling', to: 'active' });
  });

  it('reactivates a cancelling trial back to the trial, and refuses when there is nothing to go back to', () => {
    const trial = run(facts('cancelling', { authorized: false, trialEndsAt: at(3) }), {
      type: 'reactivated',
    });
    const nothing = run(facts('cancelling', { authorized: false, trialEndsAt: at(-3) }), {
      type: 'reactivated',
    });

    expect(trial).toMatchObject({ changed: true, to: 'trial' });
    expect(nothing).toMatchObject({ changed: false, reason: 'not_allowed' });
  });

  it('does not reactivate after the period ended', () => {
    const result = run(facts('cancelling', { authorized: true, paidThrough: at(-1) }), {
      type: 'reactivated',
    });

    expect(result).toMatchObject({ changed: false, reason: 'not_allowed' });
  });

  it('authorization confirmed while cancelling brings the subscription back to active', () => {
    expect(
      run(facts('cancelling', { authorized: true }), { type: 'authorization_confirmed' }),
    ).toMatchObject({ changed: true, to: 'active' });
  });
});

describe('the subscription state machine is total and agrees with the table of allowed changes', () => {
  const EVENTS: SubscriptionEvent[] = [
    { type: 'authorization_confirmed' },
    { type: 'payment_approved' },
    { type: 'payment_rejected', at: at(-1) },
    { type: 'trial_ended' },
    { type: 'grace_expired' },
    { type: 'coverage_ended' },
    { type: 'period_ended' },
    { type: 'cancel_requested' },
    { type: 'reactivated' },
    { type: 'unconfirmed' },
  ];

  const states = (status: SubscriptionStatus): SubscriptionFacts[] => [
    facts(status),
    facts(status, { trialEndsAt: at(5), authorized: true, paidThrough: at(-3) }),
    facts(status, {
      trialEndsAt: at(-5),
      authorized: false,
      paidThrough: null,
      graceEndsAt: at(-1),
    }),
  ];

  it('answers every state and every event, and never leaves the table', () => {
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const event of EVENTS) {
        for (const state of states(from)) {
          const result = run(state, event);
          expect(result.from, `${from} ${event.type}`).toBe(from);
          if (result.changed) {
            expect(ALLOWED_TRANSITIONS[from], `${from} -> ${result.to} by ${event.type}`).toContain(
              result.to,
            );
          } else {
            expect(result.to).toBe(from);
          }
          expect(result.tenantStatus).toBe(derivedTenantStatus(result.to));
        }
      }
    }
  });

  it('never leaves cancelled, and reaches every other state from somewhere', () => {
    expect(ALLOWED_TRANSITIONS['cancelled']).toEqual([]);
    const reached = new Set(Object.values(ALLOWED_TRANSITIONS).flat());
    for (const status of SUBSCRIPTION_STATUSES) {
      if (status !== 'trial') expect(reached.has(status), status).toBe(true);
    }
    expect(reached.has('trial')).toBe(true);
  });

  it('derives the state of the organization from the subscription, never the other way', () => {
    expect(derivedTenantStatus('trial')).toBe('active');
    expect(derivedTenantStatus('past_due')).toBe('active');
    expect(derivedTenantStatus('cancelling')).toBe('active');
    expect(derivedTenantStatus('read_only')).toBe('read_only');
    expect(derivedTenantStatus('cancelled')).toBe('cancelled');
  });

  it('property: a run of unconfirmed inputs (an outage, a timeout, an unknown outcome) never changes anything', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUBSCRIPTION_STATUSES),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: -400, max: 400 }),
        (status, length, offsetDays) => {
          const state = facts(status, {
            trialEndsAt: at(offsetDays),
            graceEndsAt: status === 'past_due' || status === 'read_only' ? at(offsetDays) : null,
            paidThrough: at(offsetDays / 2),
          });
          let current = state;
          for (let step = 0; step < length; step += 1) {
            const result = run(current, { type: 'unconfirmed' }, at(offsetDays + step));
            expect(result.changed).toBe(false);
            expect(result.publishCancelled).toBe(false);
            current = { ...current, status: result.to, graceEndsAt: result.graceEndsAt };
          }
          expect(current.status).toBe(state.status);
          expect(current.graceEndsAt).toEqual(state.graceEndsAt);
        },
      ),
    );
  });

  it('property: no event ever takes the subscription to read-only except the end of the grace', () => {
    const arbitrary = fc.constantFrom(...EVENTS);
    fc.assert(
      fc.property(fc.constantFrom(...SUBSCRIPTION_STATUSES), arbitrary, (status, event) => {
        const result = run(facts(status), event);
        if (result.changed && result.to === 'read_only') {
          expect(event.type).toBe('grace_expired');
        }
      }),
    );
  });
});
