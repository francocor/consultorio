import { describe, expect, it } from 'vitest';

import type { PaymentLinkDescription, PreapprovalDescription } from '../application/ports.js';

import {
  decideAmountChangeAttempt,
  decideCancelAttempt,
  decideLinkAttempt,
  decidePreapprovalAttempt,
  decideRefundAttempt,
  type Timing,
} from './attempt-decisions.js';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const open: Timing = { now: NOW, settleUntil: new Date(NOW.getTime() + 60_000) };
const settled: Timing = { now: NOW, settleUntil: new Date(NOW.getTime() - 1) };

const asked = {
  externalReference: 'sub:abc:1',
  payerEmail: 'duena@clinica.example',
  amountCents: 3_600_000,
};

function preapproval(overrides: Partial<PreapprovalDescription> = {}): PreapprovalDescription {
  return {
    preapprovalId: 'PRE-1',
    externalReference: asked.externalReference,
    payerEmail: asked.payerEmail,
    amountCents: asked.amountCents,
    currency: 'ARS',
    status: 'pending',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function link(overrides: Partial<PaymentLinkDescription> = {}): PaymentLinkDescription {
  return {
    linkId: 'LNK-1',
    externalReference: asked.externalReference,
    payerEmail: asked.payerEmail,
    amountCents: asked.amountCents,
    currency: 'ARS',
    url: 'https://pay.example/LNK-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('an unknown preapproval attempt is decided by what the provider holds, never by a guess', () => {
  it('adopts the one preapproval whose every identifying field equals what was asked', () => {
    const found = preapproval();

    expect(decidePreapprovalAttempt({ asked, found: [found], timing: open })).toEqual({
      kind: 'adopt',
      resource: found,
    });
    // The address of the payer is compared without caring about case.
    expect(
      decidePreapprovalAttempt({
        asked,
        found: [preapproval({ payerEmail: 'DUENA@clinica.example' })],
        timing: settled,
      }).kind,
    ).toBe('adopt');
  });

  it('parks it when the one it holds differs in any identifying field: a payer, an amount', () => {
    for (const different of [
      preapproval({ payerEmail: 'otra@clinica.example' }),
      preapproval({ amountCents: 1 }),
      preapproval({ externalReference: 'sub:abc:2' }),
    ]) {
      expect(
        decidePreapprovalAttempt({ asked, found: [different], timing: settled }),
        JSON.stringify(different),
      ).toEqual({ kind: 'park', reason: 'identity_mismatch' });
    }
  });

  it('parks it when more than one preapproval could be ours: it never picks one', () => {
    const verdict = decidePreapprovalAttempt({
      asked,
      found: [preapproval({ preapprovalId: 'PRE-1' }), preapproval({ preapprovalId: 'PRE-2' })],
      timing: settled,
    });

    expect(verdict).toEqual({ kind: 'park', reason: 'ambiguous_preapproval' });
  });

  it('parks it when one matches and another carries the reference with other facts', () => {
    const verdict = decidePreapprovalAttempt({
      asked,
      found: [preapproval(), preapproval({ preapprovalId: 'PRE-2', amountCents: 5 })],
      timing: settled,
    });

    expect(verdict.kind).toBe('park');
  });

  it('waits while a request that was given up on may still land, and releases only after the window', () => {
    expect(decidePreapprovalAttempt({ asked, found: [], timing: open })).toEqual({
      kind: 'wait',
      reason: 'in_flight',
    });
    expect(decidePreapprovalAttempt({ asked, found: [], timing: settled })).toEqual({
      kind: 'release',
    });
  });

  it('waits when the provider cannot be asked: not knowing is not a reason to release', () => {
    expect(decidePreapprovalAttempt({ asked, found: 'unavailable', timing: settled })).toEqual({
      kind: 'wait',
      reason: 'unavailable',
    });
  });
});

describe('an unknown payment link attempt follows the same rules', () => {
  it('adopts, parks, waits and releases', () => {
    expect(decideLinkAttempt({ asked, found: [link()], timing: open }).kind).toBe('adopt');
    expect(
      decideLinkAttempt({ asked, found: [link({ amountCents: 1 })], timing: settled }),
    ).toEqual({ kind: 'park', reason: 'identity_mismatch' });
    expect(
      decideLinkAttempt({ asked, found: [link(), link({ linkId: 'LNK-2' })], timing: settled }),
    ).toEqual({ kind: 'park', reason: 'ambiguous_preapproval' });
    expect(decideLinkAttempt({ asked, found: [], timing: open }).kind).toBe('wait');
    expect(decideLinkAttempt({ asked, found: [], timing: settled }).kind).toBe('release');
    expect(decideLinkAttempt({ asked, found: 'unavailable', timing: settled }).kind).toBe('wait');
  });
});

describe('an unknown change of amount is decided by the amount the preapproval holds', () => {
  const base = { previousCents: 3_600_000, askedCents: 5_000_000 };

  it('adopts when the new amount is there, releases when the old one stays after the window', () => {
    expect(
      decideAmountChangeAttempt({
        ...base,
        found: { amountCents: 5_000_000, status: 'authorized' },
        timing: open,
      }).kind,
    ).toBe('adopt');
    expect(
      decideAmountChangeAttempt({
        ...base,
        found: { amountCents: 3_600_000, status: 'authorized' },
        timing: settled,
      }).kind,
    ).toBe('release');
  });

  it('waits while the window is open, and parks an amount that is neither', () => {
    expect(
      decideAmountChangeAttempt({
        ...base,
        found: { amountCents: 3_600_000, status: 'authorized' },
        timing: open,
      }).kind,
    ).toBe('wait');
    expect(
      decideAmountChangeAttempt({
        ...base,
        found: { amountCents: 4_000_000, status: 'authorized' },
        timing: settled,
      }),
    ).toEqual({ kind: 'park', reason: 'unexpected_state' });
    expect(decideAmountChangeAttempt({ ...base, found: 'unknown', timing: settled }).kind).toBe(
      'park',
    );
    expect(decideAmountChangeAttempt({ ...base, found: 'unavailable', timing: settled }).kind).toBe(
      'wait',
    );
  });
});

describe('an unknown cancellation is decided by the state the preapproval holds', () => {
  it('adopts a cancelled preapproval, and releases an authorized one after the window', () => {
    expect(decideCancelAttempt({ found: { status: 'cancelled' }, timing: open }).kind).toBe(
      'adopt',
    );
    expect(decideCancelAttempt({ found: { status: 'authorized' }, timing: open }).kind).toBe(
      'wait',
    );
    expect(decideCancelAttempt({ found: { status: 'authorized' }, timing: settled }).kind).toBe(
      'release',
    );
    expect(decideCancelAttempt({ found: 'unknown', timing: settled }).kind).toBe('park');
  });
});

describe('an unknown refund is compared with the refunds the payment had BEFORE the call', () => {
  const before = ['RFD-1'];
  const refund = (refundId: string, amountCents: number) => ({
    refundId,
    amountCents,
    createdAt: NOW.toISOString(),
  });

  it('adopts exactly one new refund of the amount that was asked', () => {
    const verdict = decideRefundAttempt({
      refundIdsBefore: before,
      askedCents: 400_000,
      found: { refunds: [refund('RFD-1', 100_000), refund('RFD-2', 400_000)] },
      timing: open,
    });

    expect(verdict).toEqual({ kind: 'adopt', resource: refund('RFD-2', 400_000) });
  });

  it('releases only when there is no new refund and the window passed: it can be sent again', () => {
    const found = { refunds: [refund('RFD-1', 100_000)] };

    expect(
      decideRefundAttempt({ refundIdsBefore: before, askedCents: 400_000, found, timing: open })
        .kind,
    ).toBe('wait');
    expect(
      decideRefundAttempt({ refundIdsBefore: before, askedCents: 400_000, found, timing: settled })
        .kind,
    ).toBe('release');
  });

  it('parks two new refunds, or one of another amount: money moved that nobody asked for', () => {
    expect(
      decideRefundAttempt({
        refundIdsBefore: before,
        askedCents: 400_000,
        found: {
          refunds: [refund('RFD-1', 100_000), refund('RFD-2', 400_000), refund('RFD-3', 400_000)],
        },
        timing: settled,
      }).kind,
    ).toBe('park');
    expect(
      decideRefundAttempt({
        refundIdsBefore: before,
        askedCents: 400_000,
        found: { refunds: [refund('RFD-1', 100_000), refund('RFD-2', 300_000)] },
        timing: settled,
      }).kind,
    ).toBe('park');
  });

  it('waits when the payment cannot be read', () => {
    expect(
      decideRefundAttempt({
        refundIdsBefore: before,
        askedCents: 1,
        found: 'unavailable',
        timing: settled,
      }).kind,
    ).toBe('wait');
  });
});
