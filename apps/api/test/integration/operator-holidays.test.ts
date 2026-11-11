import type { HolidayDto, OperatorHolidayDto } from '@consultorio/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { platformAuditEvent } from '../../src/db/schema/operator.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { createTestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let harness: OperatorHarness;
let app: FastifyInstance;
let clock: TestClock;
let cookie: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  });
  cookie = await operatorSession(app, await harness.addOperator(), clock);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await runtime.close();
});

const send = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
  session = cookie,
) =>
  app.inject({
    method,
    url,
    headers: platformHeaders(session),
    remoteAddress: '10.96.0.2',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function lastPlatformEvent(action: 'holiday.added' | 'holiday.removed') {
  const [row] = await harness.db.db
    .select()
    .from(platformAuditEvent)
    .where(eq(platformAuditEvent.action, action))
    .orderBy(desc(platformAuditEvent.occurredAt))
    .limit(1);
  return row;
}

/** What an organization sees for a year, through its own host. */
async function organizationSees(slug: string, userId: Awaited<ReturnType<typeof createTestUser>>) {
  const session = await signInAs(app, slug, userId);
  const response = await clientFor(app, slug).get('/holidays?year=2031', session);
  return response.json<{ holidays: HolidayDto[] }>().holidays;
}

describe('the holiday catalog is data the operator maintains', () => {
  it('shows an added holiday to every organization at once, with no release', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-holidays-a' });
    const other = await createTestTenant(runtime, { slug: 'op-holidays-b' });
    const user = await createTestUser(runtime, tenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    const neighbour = await createTestUser(runtime, other.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    expect(
      (await organizationSees('op-holidays-a', user)).some((h) => h.day === '2031-03-03'),
    ).toBe(false);

    const added = await send('POST', '/operator/holidays', {
      country: 'AR',
      date: '2031-03-03',
      name: 'Feriado puente extraordinario',
      kind: 'bridge',
    });

    expect(added.statusCode).toBe(201);
    expect(added.json<OperatorHolidayDto>()).toMatchObject({
      country: 'AR',
      date: '2031-03-03',
      kind: 'bridge',
    });
    for (const [slug, member] of [
      ['op-holidays-a', user],
      ['op-holidays-b', neighbour],
    ] as const) {
      expect(
        (await organizationSees(slug, member)).find((h) => h.day === '2031-03-03'),
      ).toMatchObject({
        name: 'Feriado puente extraordinario',
        source: 'bridge',
      });
    }
    expect(await lastPlatformEvent('holiday.added')).toMatchObject({
      outcome: 'allow',
      resourceType: 'holiday',
      resourceId: added.json<OperatorHolidayDto>().id,
    });
  });

  it('removes a holiday added by mistake without deleting the row, and can restore it', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-holidays-c' });
    const user = await createTestUser(runtime, tenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    const added = (
      await send('POST', '/operator/holidays', {
        country: 'AR',
        date: '2031-04-07',
        name: 'Typo',
        kind: 'national',
      })
    ).json<OperatorHolidayDto>();

    const removed = await send('DELETE', `/operator/holidays/${added.id}`);

    expect(removed.statusCode).toBe(204);
    expect(
      (await organizationSees('op-holidays-c', user)).some((h) => h.day === '2031-04-07'),
    ).toBe(false);
    expect(await lastPlatformEvent('holiday.removed')).toMatchObject({ resourceId: added.id });
    expect((await send('DELETE', `/operator/holidays/${added.id}`)).statusCode).toBe(404);

    const again = await send('POST', '/operator/holidays', {
      country: 'AR',
      date: '2031-04-07',
      name: 'Typo',
      kind: 'national',
    });
    expect(again.json<OperatorHolidayDto>().id).toBe(added.id);
    expect(
      (await organizationSees('op-holidays-c', user)).some((h) => h.day === '2031-04-07'),
    ).toBe(true);
  });

  it('lists the catalog of a country and year for the console', async () => {
    const response = await send('GET', '/operator/holidays?country=AR&year=2031');

    expect(response.statusCode).toBe(200);
    const { holidays } = response.json<{ holidays: OperatorHolidayDto[] }>();
    expect(holidays.some((h) => h.date === '2031-03-03')).toBe(true);
    expect(holidays.map((h) => h.date)).toEqual([...holidays.map((h) => h.date)].sort());
  });

  it('refuses a malformed holiday', async () => {
    for (const body of [
      { country: 'AR', date: '2031-13-40', name: 'x', kind: 'national' },
      { country: 'AR', date: '2031-05-01', name: '', kind: 'national' },
      { country: 'AR', date: '2031-05-01', name: 'x', kind: 'local' },
      { country: 'argentina', date: '2031-05-01', name: 'x', kind: 'national' },
    ]) {
      expect((await send('POST', '/operator/holidays', body)).statusCode).toBe(400);
    }
  });
});

describe('only the operator reaches it', () => {
  it('answers a tenant host and an unauthenticated caller as it answers an unknown route', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-holidays-d' });
    const owner = await signInAs(
      app,
      'op-holidays-d',
      await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    const fromTenant = await app.inject({
      method: 'POST',
      url: '/operator/holidays',
      headers: browserHeaders('op-holidays-d', owner.cookie),
      payload: { country: 'AR', date: '2031-06-01', name: 'x', kind: 'national' },
    });
    const anonymous = await app.inject({
      method: 'GET',
      url: '/operator/holidays?country=AR&year=2031',
      headers: platformHeaders(),
    });

    expect(fromTenant.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(401);
  });

  it('is not a way to write the catalog from an organization: the runtime role has no write', async () => {
    const attempt = runtime.db.execute(
      sql`insert into holiday_catalog (country, date, name, kind) values ('AR', '2031-07-01', 'x', 'national')`,
    );

    await expect(attempt).rejects.toThrow();
  });
});
