import { describe, expect, it } from 'vitest';

import { AppError } from '../../../../platform/http/problem.js';

import { createSignupService, type Origin, type SignupServiceDeps } from './service.js';

/**
 * The counters of the public form when their store fails (JD-S6 R1-A-T6). The service is built with
 * doubles that fail the moment they are used, so what is checked is only the decision the limits make.
 */
class Reached extends Error {}

function build(store: SignupServiceDeps['store']) {
  const unused = new Proxy({}, { get: () => () => Promise.reject(new Reached()) });
  return createSignupService({
    withTenant: () => Promise.reject(new Reached()),
    hasher: unused as never,
    validator: unused as never,
    tokens: unused as never,
    keys: unused as never,
    store,
    email: unused as never,
    mailer: unused as never,
    trial: unused as never,
    sessions: unused as never,
    clock: () => new Date('2031-01-01T00:00:00Z'),
  });
}

const failing: SignupServiceDeps['store'] = {
  hit: () => Promise.reject(new Error('the store is down')),
};

function origin() {
  const told: string[] = [];
  const value: Origin = {
    actor: { ip: '203.0.113.7' } as never,
    warn: (event) => {
      told.push(event);
    },
  };
  return { value, told };
}

describe('the counters of the signup when their store fails', () => {
  it('refuses a signup: the overall ceiling fails closed, and says so in the log', async () => {
    const { value, told } = origin();

    const attempt = build(failing).signUp(
      {
        organizationName: 'Centro Norte',
        ownerName: 'Ana Pérez',
        email: 'ana@example.test',
        challengeProof: 'x',
      },
      value,
    );

    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ code: 'rate_limited' });
    expect(told).toContain('counters_store_failed_closed');
  });

  it('still lets a request for a new link through: that counter fails open and is only told', async () => {
    const { value, told } = origin();

    const attempt = build(failing).resend('ana@example.test', value);

    // It went past the limits and reached the database (the double), instead of being refused.
    await expect(attempt).rejects.toBeInstanceOf(Reached);
    expect(told).toContain('counters_store_failed_open');
    expect(told).not.toContain('counters_store_failed_closed');
  });
});
