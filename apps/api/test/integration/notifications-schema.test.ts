import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { message, messageAttempt } from '../../src/db/schema/notifications.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertAppointmentRow, insertPatient } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'notifications-schema-a' });
  b = await createTestTenant(runtime, { slug: 'notifications-schema-b' });
});

afterAll(async () => {
  await runtime.close();
  await owner.end();
});

const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const sendAt = new Date('2031-06-01T12:00:00Z');

/** A queued reminder of a new patient, with the columns a test wants to change. */
async function insertMessage(
  tenant: TestTenant,
  overrides: Partial<typeof message.$inferInsert> = {},
) {
  return asTenant(runtime, tenant.id, async (tx) => {
    const patientId = overrides.patientId ?? (await insertPatient(tx, tenant.id));
    const [row] = await tx
      .insert(message)
      .values({
        tenantId: tenant.id,
        patientId,
        kind: 'reminder',
        channel: 'email',
        dedupeKey: `reminder:${patientId}`,
        sendAt,
        ...overrides,
      })
      .returning();
    return row;
  });
}

describe('message', () => {
  it('starts queued, with no reason, no provider id and no attempts', async () => {
    const row = await insertMessage(a);

    expect(row).toMatchObject({
      status: 'queued',
      cancelReason: null,
      failureReason: null,
      providerMessageId: null,
      attempts: 0,
      trigger: 'automatic',
    });
  });

  it('refuses a second message with the same dedupe key in the same organization', async () => {
    const patientId = await asTenant(runtime, a.id, (tx) => insertPatient(tx, a.id));
    await insertMessage(a, { patientId, dedupeKey: 'dedupe:one' });

    expect(await dbError(insertMessage(a, { patientId, dedupeKey: 'dedupe:one' }))).toBe('23505');
  });

  it('lets two organizations use the same dedupe key', async () => {
    await insertMessage(a, { dedupeKey: 'shared:key' });
    const other = await insertMessage(b, { dedupeKey: 'shared:key' });

    expect(other?.dedupeKey).toBe('shared:key');
  });

  it('refuses a kind, a channel and a status that the product does not have', async () => {
    expect(await dbError(insertMessage(a, { kind: 'sms_blast' }))).toBe('23514');
    expect(await dbError(insertMessage(a, { channel: 'sms' }))).toBe('23514');
    expect(await dbError(insertMessage(a, { status: 'lost' }))).toBe('23514');
  });

  it('keeps WhatsApp for the messages of an appointment: a code cannot be a WhatsApp message', async () => {
    expect(await dbError(insertMessage(a, { kind: 'otp_code', channel: 'whatsapp' }))).toBe(
      '23514',
    );
    expect(await insertMessage(a, { kind: 'otp_code', channel: 'email' })).toMatchObject({
      kind: 'otp_code',
    });
  });

  it('requires a reason exactly when the message is cancelled', async () => {
    expect(await dbError(insertMessage(a, { status: 'cancelled' }))).toBe('23514');
    expect(await dbError(insertMessage(a, { cancelReason: 'opted_out' }))).toBe('23514');
    expect(
      await insertMessage(a, { status: 'cancelled', cancelReason: 'demo_tenant' }),
    ).toMatchObject({ status: 'cancelled', cancelReason: 'demo_tenant' });
  });

  it('requires a failure reason exactly when the message failed', async () => {
    expect(await dbError(insertMessage(a, { status: 'failed' }))).toBe('23514');
    expect(
      await insertMessage(a, { status: 'failed', failureReason: 'not_on_whatsapp' }),
    ).toMatchObject({ status: 'failed', failureReason: 'not_on_whatsapp' });
  });

  it('points at an appointment of the same organization only', async () => {
    const own = await asTenant(runtime, a.id, (tx) => insertAppointmentRow(tx, a.id));
    const foreign = await asTenant(runtime, b.id, (tx) => insertAppointmentRow(tx, b.id));

    expect(await insertMessage(a, { appointmentId: own, appointmentVersion: 1 })).toMatchObject({
      appointmentId: own,
    });
    expect(await dbError(insertMessage(a, { appointmentId: foreign }))).toBeDefined();
  });

  it('keeps one message per provider id across the platform', async () => {
    await insertMessage(a, { providerMessageId: 'wamid.unique-1', dedupeKey: 'prov:1' });

    expect(
      await dbError(insertMessage(b, { providerMessageId: 'wamid.unique-1', dedupeKey: 'prov:2' })),
    ).toBe('23505');
  });

  it('cannot be deleted by the application: a message is cancelled, never removed', async () => {
    const row = await insertMessage(a);
    const result = await owner.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('app_rw', 'message', 'DELETE') AS allowed`,
    );

    expect(row?.id).toBeDefined();
    expect(result.rows[0]?.allowed).toBe(false);
  });
});

describe('message_attempt', () => {
  it('records each attempt of a message once, in order', async () => {
    const row = await insertMessage(a, { dedupeKey: 'attempts:one' });
    const attempt = (attemptNo: number, outcome: 'retryable' | 'accepted') =>
      asTenant(runtime, a.id, (tx) =>
        tx.insert(messageAttempt).values({
          tenantId: a.id,
          messageId: row?.id ?? '',
          attemptNo,
          outcome,
          reason: outcome === 'retryable' ? 'provider_down' : null,
        }),
      );

    await attempt(1, 'retryable');
    await attempt(2, 'accepted');

    expect(await dbError(attempt(2, 'accepted'))).toBe('23505');
    const stored = await asTenant(runtime, a.id, (tx) =>
      tx
        .select({ attemptNo: messageAttempt.attemptNo, outcome: messageAttempt.outcome })
        .from(messageAttempt)
        .where(sql`${messageAttempt.messageId} = ${row?.id ?? ''}`)
        .orderBy(messageAttempt.attemptNo),
    );
    expect(stored).toEqual([
      { attemptNo: 1, outcome: 'retryable' },
      { attemptNo: 2, outcome: 'accepted' },
    ]);
  });

  it('refuses an outcome that is not one of the four', async () => {
    const row = await insertMessage(a, { dedupeKey: 'attempts:two' });

    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(messageAttempt).values({
            tenantId: a.id,
            messageId: row?.id ?? '',
            attemptNo: 1,
            outcome: 'maybe' as 'accepted',
          }),
        ),
      ),
    ).toBe('23514');
  });
});
