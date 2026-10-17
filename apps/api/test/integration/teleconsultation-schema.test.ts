import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { videoSession } from '../../src/db/schema/teleconsultation.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertAppointmentRow } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'video-schema-a' });
  b = await createTestTenant(runtime, { slug: 'video-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const appointmentOf = (tenant: TestTenant) =>
  asTenant(runtime, tenant.id, (tx) => insertAppointmentRow(tx, tenant.id));

describe('video_session', () => {
  it('starts a session of an appointment without a link, waiting for the provider', async () => {
    const appointmentId = await appointmentOf(a);

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx
        .insert(videoSession)
        .values({ tenantId: a.id, appointmentId, pendingReason: 'creating' })
        .returning(),
    );

    expect(row).toMatchObject({
      appointmentId,
      status: 'link_pending',
      pendingReason: 'creating',
      closeReason: null,
      manualLink: null,
      provider: null,
      firstOpenedAt: null,
      lastOpenedAt: null,
    });
  });

  it('keeps one session per appointment', async () => {
    const appointmentId = await appointmentOf(a);
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(videoSession).values({ tenantId: a.id, appointmentId, pendingReason: 'creating' }),
    );

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx
            .insert(videoSession)
            .values({ tenantId: a.id, appointmentId, pendingReason: 'creating' }),
        ),
      ),
    ).toBe('23505');
  });

  it('refuses a status that is not one of the three', async () => {
    const appointmentId = await appointmentOf(a);

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(videoSession).values({ tenantId: a.id, appointmentId, status: 'open' }),
        ),
      ),
    ).toBe('23514');
  });

  it('says why a session is pending, why it closed, and nothing in a ready one', async () => {
    const pendingWithoutReason = await appointmentOf(a);
    const readyWithReason = await appointmentOf(a);
    const closedWithoutReason = await appointmentOf(a);
    const readyAndClean = await appointmentOf(a);
    const closedWithReason = await appointmentOf(a);

    const insert = (appointmentId: string, values: Partial<typeof videoSession.$inferInsert>) =>
      dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(videoSession).values({ tenantId: a.id, appointmentId, ...values }),
        ),
      );

    expect(await insert(pendingWithoutReason, { status: 'link_pending' })).toBe('23514');
    expect(await insert(readyWithReason, { status: 'ready', pendingReason: 'creating' })).toBe(
      '23514',
    );
    expect(await insert(closedWithoutReason, { status: 'closed' })).toBe('23514');
    expect(await insert(readyAndClean, { status: 'ready' })).toBeUndefined();
    expect(await insert(closedWithReason, { status: 'closed', closeReason: 'cancelled' })).toBe(
      undefined,
    );
  });

  it('refuses a close reason or a pending reason outside the vocabulary', async () => {
    const one = await appointmentOf(a);
    const two = await appointmentOf(a);

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx
            .insert(videoSession)
            .values({ tenantId: a.id, appointmentId: one, pendingReason: 'whatever' }),
        ),
      ),
    ).toBe('23514');
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx
            .insert(videoSession)
            .values({ tenantId: a.id, appointmentId: two, status: 'closed', closeReason: 'sad' }),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a last opening before the first one, and a manual link that is too long', async () => {
    const one = await appointmentOf(a);
    const two = await appointmentOf(a);
    const first = new Date('2031-05-12T13:00:00Z');

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(videoSession).values({
            tenantId: a.id,
            appointmentId: one,
            status: 'ready',
            firstOpenedAt: first,
            lastOpenedAt: new Date(first.getTime() - 1000),
          }),
        ),
      ),
    ).toBe('23514');
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(videoSession).values({
            tenantId: a.id,
            appointmentId: two,
            status: 'ready',
            manualLink: `https://meet.example.org/${'x'.repeat(2100)}`,
          }),
        ),
      ),
    ).toBe('23514');
  });

  it('is tied to an appointment of the same organization', async () => {
    const foreign = await appointmentOf(b);

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx
            .insert(videoSession)
            .values({ tenantId: a.id, appointmentId: foreign, pendingReason: 'creating' }),
        ),
      ),
    ).toBe('23503');
  });

  it("does not show one organization's sessions to another", async () => {
    const appointmentId = await appointmentOf(a);
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(videoSession).values({ tenantId: a.id, appointmentId, pendingReason: 'creating' }),
    );

    const seenByB = await asTenant(runtime, b.id, (tx) =>
      tx.select().from(videoSession).where(eq(videoSession.appointmentId, appointmentId)),
    );
    const seenByA = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(videoSession).where(eq(videoSession.appointmentId, appointmentId)),
    );

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);
  });

  it('is never deleted: a session ends by closing', async () => {
    const appointmentId = await appointmentOf(a);
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(videoSession).values({ tenantId: a.id, appointmentId, pendingReason: 'creating' }),
    );

    const code = await dbError(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(sql`DELETE FROM video_session WHERE appointment_id = ${appointmentId}`),
      ),
    );

    expect(code).toBe('42501');
  });
});
