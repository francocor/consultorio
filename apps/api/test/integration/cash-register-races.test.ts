import type { PaymentResultResponse, Problem } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { createBillingWorld, submissionKey, type BillingWorld } from '../support/billing-world.js';
import { gate, waitForLockWaiters } from '../support/lock-waits.js';
import { signInAs, TEST_PASSWORD } from '../support/session.js';
import { asTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * Judgment day, Stage 4, round 1: findings C1, C11 and B-T4. The close of a register, a payment and
 * a refund meet on two connections: the entry must either be in the total the register closed with,
 * or be refused. These are real two connection tests; each one fails on the code before the fix.
 */

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'cash-races' });
  await world.setPrice(1_500_000);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** What a close writes, straight to the table: the row is locked, then moved to `closed`. */
async function closeRegisterAndHold(registerId: string, release: Promise<void>, held: () => void) {
  await asTenant(runtime, world.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT id FROM cash_session WHERE id = ${registerId} FOR UPDATE`);
    await tx.execute(
      sql`UPDATE cash_session
             SET status = 'closed', closed_at = now(), closed_by = ${world.reception.user.id},
                 expected_cents = 0, counted_cents = 0, difference_cents = 0
           WHERE id = ${registerId}`,
    );
    held();
    await release;
  });
}

async function insertCashPayment(tx: Tx, input: { chargeId: string; registerId: string }) {
  await tx.execute(
    sql`INSERT INTO payment (tenant_id, charge_id, location_id, cash_session_id, method,
                             amount_cents, recorded_by, idempotency_key, request_hash)
          VALUES (${world.tenant.id}, ${input.chargeId}, ${world.centro}, ${input.registerId},
                  'cash', 100000, ${world.reception.user.id}, ${submissionKey()}, 'race')`,
  );
}

describe('a payment and the close of the register (JD-S4 R1-C1)', () => {
  it('refuses the cash of a payment that meets the close, instead of recording it in the closed register', async () => {
    const register = await world.openRegister({ openingCents: 0 });
    const charge = await world.charge();
    const held = gate();
    const release = gate();

    const closing = closeRegisterAndHold(register.id, release.opened, held.open);
    await held.opened;
    const paying = world.pay(charge.id, { method: 'cash', amountCents: 500_000 });
    await waitForLockWaiters();
    release.open();
    await closing;
    const response = await paying;

    // The register is closed: the cash has no register to go in.
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('cash_register_required');
    const inClosed = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payment WHERE cash_session_id = ${register.id}`,
      ),
    );
    expect(inClosed.rows[0]?.n).toBe(0);
  });

  it('keeps a payment that beat the close inside the total the register closes with', async () => {
    const register = await world.openRegister({ openingCents: 0 });
    const charge = await world.charge();
    const held = gate();
    const release = gate();

    // The payment is written first and held; the close then has to wait for it.
    const writing = asTenant(runtime, world.tenant.id, async (tx) => {
      await insertCashPayment(tx, { chargeId: charge.id, registerId: register.id });
      held.open();
      await release.opened;
    });
    await held.opened;
    const closing = world.api.post(`/billing/cash/sessions/${register.id}/close`, world.reception, {
      countedCents: 100_000,
    });
    await waitForLockWaiters();
    release.open();
    await writing;
    const closed = await closing;

    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<{ expectedCents: number }>().expectedCents).toBe(100_000);
  });

  it('refuses at the database a cash payment written while the register closes', async () => {
    const register = await world.openRegister({ openingCents: 0 });
    const charge = await world.charge();
    const held = gate();
    const release = gate();

    const closing = closeRegisterAndHold(register.id, release.opened, held.open);
    await held.opened;
    // Straight into the table, as code that already read the register as open would.
    const writing = asTenant(runtime, world.tenant.id, (tx) =>
      insertCashPayment(tx, { chargeId: charge.id, registerId: register.id }),
    ).then(
      () => 'written',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'refused',
    );
    await waitForLockWaiters();
    release.open();
    await closing;

    expect(await writing).toMatch(/closed cash register/);
  });

  it('refuses at the database a refund written while the register closes', async () => {
    const register = await world.openRegister({ openingCents: 0 });
    const charge = await world.charge();
    const paid = await world.pay(charge.id, { method: 'cash', amountCents: 300_000 });
    const paymentId = paid.json<PaymentResultResponse>().payment.id;
    const held = gate();
    const release = gate();

    const closing = closeRegisterAndHold(register.id, release.opened, held.open);
    await held.opened;
    const writing = asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute(
        sql`INSERT INTO payment_reversal (tenant_id, payment_id, charge_id, location_id,
                                          cash_session_id, amount_cents, reason, kind, reversed_by,
                                          idempotency_key, request_hash)
              VALUES (${world.tenant.id}, ${paymentId}, ${charge.id}, ${world.centro},
                      ${register.id}, 100000, 'devolucion', 'refund',
                      ${world.reception.user.id}, ${submissionKey()}, 'race')`,
      ),
    ).then(
      () => 'written',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'refused',
    );
    await waitForLockWaiters();
    release.open();
    await closing;

    expect(await writing).toMatch(/closed cash register/);
  });
});

describe('the reversals of a payment (JD-S4 R1-C11)', () => {
  async function cashPayment() {
    await world.openRegister({ openingCents: 0 }).catch(() => undefined);
    const charge = await world.charge();
    const paid = await world.pay(charge.id, { method: 'cash', amountCents: 1_000_000 });
    expect(paid.statusCode, paid.body).toBe(201);
    return { charge, paymentId: paid.json<PaymentResultResponse>().payment.id };
  }

  const reversal = (
    tx: Tx,
    input: { paymentId: string; chargeId: string; registerId: string; cents: number },
  ) =>
    tx.execute(
      sql`INSERT INTO payment_reversal (tenant_id, payment_id, charge_id, location_id,
                                        cash_session_id, amount_cents, reason, kind, reversed_by,
                                        idempotency_key, request_hash)
            VALUES (${world.tenant.id}, ${input.paymentId}, ${input.chargeId}, ${world.centro},
                    ${input.registerId}, ${input.cents}, 'devolucion', 'refund',
                    ${world.reception.user.id}, ${submissionKey()}, 'race')`,
    );

  async function openRegisterId(): Promise<string> {
    const result = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM cash_session WHERE status = 'open' AND location_id = ${world.centro}`,
      ),
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('no open register');
    return id;
  }

  it('refuses a reversal that names another charge than the one of its payment', async () => {
    const { paymentId } = await cashPayment();
    const other = await world.charge();
    const registerId = await openRegisterId();

    const attempt = asTenant(runtime, world.tenant.id, (tx) =>
      reversal(tx, { paymentId, chargeId: other.id, registerId, cents: 100_000 }),
    );

    await expect(attempt).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/charge of its payment/) as string },
    });
  });

  it('makes two reversals that race for the same payment wait, so together they never exceed it', async () => {
    const { charge, paymentId } = await cashPayment();
    const registerId = await openRegisterId();
    const held = gate();
    const release = gate();

    const first = asTenant(runtime, world.tenant.id, async (tx) => {
      await reversal(tx, { paymentId, chargeId: charge.id, registerId, cents: 600_000 });
      held.open();
      await release.opened;
    });
    await held.opened;
    const second = asTenant(runtime, world.tenant.id, (tx) =>
      reversal(tx, { paymentId, chargeId: charge.id, registerId, cents: 600_000 }),
    ).then(
      () => 'written',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'refused',
    );
    await waitForLockWaiters();
    release.open();
    await first;

    expect(await second).toMatch(/cannot exceed the payment/);
  });
});

describe('a unique violation on a payment (JD-S4 R1-C10)', () => {
  it('tells a reused idempotency key from a repeated voucher when two submissions meet at the index', async () => {
    const first = await world.charge();
    const second = await world.charge();
    const key = submissionKey();
    const held = gate();
    const release = gate();

    // Another submission with the same key wrote its payment and has not committed yet.
    const writing = asTenant(runtime, world.tenant.id, async (tx) => {
      await tx.execute(
        sql`INSERT INTO payment (tenant_id, charge_id, location_id, method, amount_cents,
                                 recorded_by, idempotency_key, request_hash)
              VALUES (${world.tenant.id}, ${first.id}, ${world.centro}, 'debit', 100000,
                      ${world.reception.user.id}, ${key}, 'other')`,
      );
      held.open();
      await release.opened;
    });
    await held.opened;
    const paying = world.pay(second.id, {
      method: 'debit',
      amountCents: 200_000,
      idempotencyKey: key,
    });
    await waitForLockWaiters();
    release.open();
    await writing;
    const response = await paying;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('idempotency_key_reused');
  });

  it('still answers a repeated voucher with payment_voucher_duplicate', async () => {
    const first = await world.charge();
    const second = await world.charge();
    const voucher = '88112233';
    const paid = await world.pay(first.id, {
      method: 'transfer',
      amountCents: 100_000,
      externalRef: voucher,
    });
    expect(paid.statusCode, paid.body).toBe(201);

    const again = await world.pay(second.id, {
      method: 'transfer',
      amountCents: 100_000,
      externalRef: voucher,
    });

    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<Problem>().code).toBe('payment_voucher_duplicate');
  });
});

describe('who may put money in a register (JD-S4 R1-B-T4)', () => {
  it('refuses a payment of someone who sees the charge as its professional but does not work at the register location', async () => {
    const register = await world.openRegister({ openingCents: 0 }).catch(async () => {
      const result = await asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute<{ id: string }>(
          sql`SELECT id FROM cash_session WHERE status = 'open' AND location_id = ${world.centro}`,
        ),
      );
      return { id: result.rows[0]?.id ?? '' };
    });
    // Reception staff who is also a health professional: the charge of their own appointment is
    // theirs to see, but no location is assigned to them.
    const created = await createTestProfessional(runtime, world.tenant.id, {
      password: TEST_PASSWORD,
      alsoRoles: ['reception'],
    });
    const session = await signInAs(world.app, world.slug, created);
    const dual = {
      ...session,
      professionalId: created.professionalId,
      membershipId: created.membershipId,
    };
    const hours = await world.api.put(`/professionals/${dual.professionalId}/hours`, dual, {
      hours: [{ locationId: world.centro, weekday: 1, start: '09:00', end: '13:00' }],
    });
    expect(hours.statusCode, hours.body).toBe(200);
    const appointment = await world.appointment({ professional: dual });
    const captured = await world.api.post('/billing/charges', world.reception, {
      appointmentId: appointment.id,
    });
    const chargeId = captured.json<{ id: string }>().id;

    const response = await world.pay(chargeId, { method: 'debit', amountCents: 200_000 }, dual);

    // The charge is theirs, the register of Centro is not: it answers like one that does not exist.
    expect(response.statusCode, response.body).toBe(404);
    const inRegister = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payment
             WHERE cash_session_id = ${register.id} AND recorded_by = ${dual.user.id}`,
      ),
    );
    expect(inRegister.rows[0]?.n).toBe(0);
  });
});
