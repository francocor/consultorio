import { Problem } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { TEST_PASSWORD } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

/**
 * Security review finding 2: behind one reverse proxy the client address is the hop the proxy
 * appended, so rotating fake X-Forwarded-For values neither bypasses the sign-in limit nor forges
 * the audit address, and a value that is not an address never turns into a 500.
 */
let runtime: DbHandle;
let app: FastifyInstance;
let tenant: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, {
    trustProxy: 1,
    limits: {
      perClient: { max: 100, windowMs: 60_000 },
      perTenant: { max: 100, windowMs: 60_000 },
      login: { max: 3, timeWindow: 60_000 },
    },
  });
  tenant = await createTestTenant(runtime, { slug: 'client-address' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const login = (forwardedFor: string, email: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...browserHeaders('client-address'), 'x-forwarded-for': forwardedFor },
    // The proxy's own address: what the socket shows.
    remoteAddress: '10.0.0.2',
    payload: { email, password },
  });

async function lastAuditIp(action: 'auth.login.success' | 'auth.login.failed') {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select({ ip: auditEvent.ip })
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt))
      .limit(1),
  );
  return row?.ip;
}

describe('client address behind one trusted proxy', () => {
  it('cannot bypass the sign-in limit by rotating fake X-Forwarded-For values', async () => {
    const statuses: number[] = [];
    for (const fake of ['6.6.6.1', '6.6.6.2', '6.6.6.3', '6.6.6.4', '6.6.6.5']) {
      const response = await login(`${fake}, 198.51.100.77`, 'someone@example.test', 'wrong');
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('records the address the proxy saw, not what the client wrote', async () => {
    const user = await createTestUser(runtime, tenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });

    const response = await login('6.6.6.6, 198.51.100.88', user.email, TEST_PASSWORD);

    expect(response.statusCode).toBe(200);
    expect(await lastAuditIp('auth.login.success')).toBe('198.51.100.88');
  });

  it('answers normally and audits no address when X-Forwarded-For is not an address', async () => {
    const response = await login('not-an-ip', 'nobody@example.test', 'wrong-password');

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json()).code).toBe('unauthenticated');
    expect(await lastAuditIp('auth.login.failed')).toBeNull();
  });
});
