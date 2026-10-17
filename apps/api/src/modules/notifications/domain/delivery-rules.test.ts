import { describe, expect, it } from 'vitest';

import { EmailDeliveryError } from '../../../platform/mail/email-sender.js';

import { hashAddress } from './address.js';
import { classifyEmailFailure, MAX_ATTEMPTS, nextRetryAt } from './delivery-rules.js';

const failure = (cause: unknown) => new EmailDeliveryError({ cause });
const smtp = (responseCode: number) => Object.assign(new Error('smtp'), { responseCode });

describe('nextRetryAt', () => {
  const now = new Date('2031-05-10T10:00:00.000Z');
  const farAway = new Date('2031-05-12T13:00:00.000Z');

  it('waits longer after each failed attempt: one, five and fifteen minutes', () => {
    expect(nextRetryAt(now, 1, farAway)).toEqual(new Date('2031-05-10T10:01:00.000Z'));
    expect(nextRetryAt(now, 2, farAway)).toEqual(new Date('2031-05-10T10:05:00.000Z'));
  });

  it('stops after the last attempt', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(nextRetryAt(now, MAX_ATTEMPTS, farAway)).toBeNull();
    expect(nextRetryAt(now, MAX_ATTEMPTS + 1, farAway)).toBeNull();
  });

  it('never schedules a try at or after the start of the appointment', () => {
    const startsInThirtySeconds = new Date(now.getTime() + 30_000);
    const startsInTwoMinutes = new Date(now.getTime() + 120_000);

    expect(nextRetryAt(now, 1, startsInThirtySeconds)).toBeNull();
    expect(nextRetryAt(now, 1, new Date(now.getTime() + 60_000))).toBeNull();
    expect(nextRetryAt(now, 1, startsInTwoMinutes)).toEqual(new Date('2031-05-10T10:01:00.000Z'));
  });

  it('retries when there is no start to respect (a notice that is not about an appointment)', () => {
    expect(nextRetryAt(now, 1, null)).toEqual(new Date('2031-05-10T10:01:00.000Z'));
  });
});

describe('classifyEmailFailure', () => {
  it('treats a refusal by the receiving server as permanent: the mailbox does not exist', () => {
    expect(classifyEmailFailure(failure(smtp(550)))).toBe('permanent');
    expect(classifyEmailFailure(failure(smtp(553)))).toBe('permanent');
  });

  it('treats a temporary answer, a timeout and a dropped connection as transient', () => {
    expect(classifyEmailFailure(failure(smtp(421)))).toBe('transient');
    expect(classifyEmailFailure(failure(smtp(451)))).toBe('transient');
    expect(
      classifyEmailFailure(failure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))),
    ).toBe('transient');
    expect(classifyEmailFailure(failure(new Error('socket hang up')))).toBe('transient');
  });

  it('treats a problem of ours or of the server (5xx that is not about the mailbox) as transient', () => {
    expect(classifyEmailFailure(failure(smtp(535)))).toBe('transient');
    expect(classifyEmailFailure(failure(smtp(552)))).toBe('transient');
  });

  it('treats an error it does not recognize as transient, never as proof of a bad address', () => {
    expect(classifyEmailFailure('boom')).toBe('transient');
    expect(classifyEmailFailure(undefined)).toBe('transient');
  });
});

describe('hashAddress', () => {
  it('is the same for an address written in another case and with spaces around it', () => {
    expect(hashAddress('email', ' Ana@Example.Test ')).toBe(
      hashAddress('email', 'ana@example.test'),
    );
  });

  it('keeps an email and a number apart even when they would read the same', () => {
    expect(hashAddress('email', '+5491144445555')).not.toBe(
      hashAddress('whatsapp', '+5491144445555'),
    );
  });

  it('does not contain the address', () => {
    expect(hashAddress('email', 'ana@example.test')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAddress('email', 'ana@example.test')).not.toContain('ana');
  });
});
