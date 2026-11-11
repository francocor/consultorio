import { Problem } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, {
    limits: {
      perClient: { max: 100, windowMs: 60_000 },
      perTenant: { max: 100, windowMs: 60_000 },
      login: { max: 3, timeWindow: 60_000 },
    },
  });
  await createTestTenant(runtime, { slug: 'ratelimit-a' });
  await createTestTenant(runtime, { slug: 'ratelimit-b' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const attempt = (slug: string, ip: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: browserHeaders(slug),
    remoteAddress: ip,
    payload: { email: 'someone@example.test', password: 'whatever-password' },
  });

describe('sign-in rate limit on the real application', () => {
  it('answers 429 after the limit, per client address and tenant', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1)
      statuses.push((await attempt('ratelimit-a', '192.0.2.10')).statusCode);

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const blocked = await attempt('ratelimit-a', '192.0.2.10');
    expect(Problem.parse(blocked.json()).code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keeps the allowance of the same client on another tenant, and of other clients', async () => {
    for (let i = 0; i < 4; i += 1) await attempt('ratelimit-a', '192.0.2.20');

    expect((await attempt('ratelimit-b', '192.0.2.20')).statusCode).toBe(401);
    expect((await attempt('ratelimit-a', '192.0.2.21')).statusCode).toBe(401);
  });
});
