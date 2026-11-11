import type {
  CashSessionDetailResponse,
  ChargeDto,
  PaymentResultResponse,
  Problem,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, submissionKey, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * Refunds and corrections (billing-payments, "Refunds and payment reversals", "Closed register
 * immutability"): entries added, never edited; never more than what was paid; a correction after
 * the register closed lands in the open register and leaves the closed one as it was.
 */

const PRICE = 1_000_000;

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'refund-payment' });
  await world.setPrice(PRICE);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const refund = (
  paymentId: string,
  amountCents: number,
  by = world.owner,
  reason = 'Devolución al paciente',
) =>
  world.api.post(`/billing/payments/${paymentId}/refund`, by, {
    amountCents,
    reason,
    idempotencyKey: submissionKey(),
  });

async function paidCharge(method = 'debit', amountCents = PRICE) {
  const charge = await world.charge();
  const response = await world.pay(charge.id, { method, amountCents });
  expect(response.statusCode, response.body).toBe(201);
  return { charge, paymentId: response.json<PaymentResultResponse>().payment.id };
}

async function audits(action: 'payment.refunded' | 'cash.adjusted' | 'access.denied') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('a refund', () => {
  it('is an entry linked to the payment, which stays as it was, and moves the charge back', async () => {
    const { charge, paymentId } = await paidCharge();

    const response = await refund(paymentId, 400_000);

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<PaymentResultResponse>();
    expect(body.payment).toMatchObject({
      id: paymentId,
      amountCents: 1_000_000,
      reversedCents: 400_000,
      netCents: 600_000,
      reversals: [{ kind: 'refund', amountCents: 400_000, reason: 'Devolución al paciente' }],
    });
    expect(body.charge).toMatchObject({
      status: 'partially_paid',
      paidCents: 600_000,
      outstandingCents: 400_000,
    });
    expect(body.charge.payments).toHaveLength(1);
    const [row] = await audits('payment.refunded');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: world.owner.user.id,
      resourceId: paymentId,
      metadata: { chargeId: charge.id, amountCents: 400_000, reason: 'Devolución al paciente' },
    });
  });

  it('takes everything back, returning the charge to pending', async () => {
    const { charge, paymentId } = await paidCharge();

    await refund(paymentId, 1_000_000);

    const after = (
      await world.api.get(`/billing/charges/${charge.id}`, world.owner)
    ).json<ChargeDto>();
    expect(after).toMatchObject({ status: 'pending', paidCents: 0, outstandingCents: 1_000_000 });
  });

  it('never exceeds what is left of the payment', async () => {
    const { paymentId } = await paidCharge();
    await refund(paymentId, 800_000);

    const over = await refund(paymentId, 300_000);
    const exact = await refund(paymentId, 200_000);
    const more = await refund(paymentId, 1);

    expect(over.statusCode).toBe(409);
    expect(over.json<Problem>().code).toBe('payment_refund_exceeds');
    expect(exact.statusCode, exact.body).toBe(201);
    expect(more.json<Problem>().code).toBe('payment_refund_exceeds');
  });

  it('answers a retried submission with the same refund, once', async () => {
    const { paymentId } = await paidCharge();
    const body = {
      amountCents: 300_000,
      reason: 'Devolución al paciente',
      idempotencyKey: submissionKey(),
    };

    const first = await world.api.post(`/billing/payments/${paymentId}/refund`, world.owner, body);
    const retry = await world.api.post(`/billing/payments/${paymentId}/refund`, world.owner, body);
    const changed = await world.api.post(`/billing/payments/${paymentId}/refund`, world.owner, {
      ...body,
      amountCents: 100_000,
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<PaymentResultResponse>().replayed).toBe(true);
    expect(retry.json<PaymentResultResponse>().payment.reversedCents).toBe(300_000);
    expect(changed.statusCode).toBe(409);
    expect(changed.json<Problem>().code).toBe('idempotency_key_reused');
  });

  it('needs a reason, a whole amount above zero, and the permission', async () => {
    const { paymentId } = await paidCharge();
    const before = (await audits('access.denied')).length;

    const noReason = await world.api.post(`/billing/payments/${paymentId}/refund`, world.owner, {
      amountCents: 100,
      idempotencyKey: submissionKey(),
    });
    const fraction = await refund(paymentId, 10.5);
    const zero = await refund(paymentId, 0);
    const byReception = await refund(paymentId, 100, world.reception);
    const byDoctor = await refund(paymentId, 100, world.doctor);
    const byAdmin = await refund(paymentId, 100, world.admin);

    expect([noReason.statusCode, fraction.statusCode, zero.statusCode]).toEqual([400, 400, 400]);
    expect([byReception.statusCode, byDoctor.statusCode]).toEqual([403, 403]);
    expect((await audits('access.denied')).length).toBe(before + 2);
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
  });

  it('answers not found for a payment that does not exist', async () => {
    const response = await refund('0190a000-0000-7000-8000-0000000000aa', 100);

    expect(response.statusCode).toBe(404);
  });
});

describe('the cash of a refund', () => {
  it('leaves the open register of the location, and is refused without one', async () => {
    const bare = await createBillingWorld(runtime, { slug: 'refund-payment-cash' });
    try {
      await bare.setPrice(PRICE);
      const first = await bare.openRegister({ openingCents: 100_000 });
      const charge = await bare.charge();
      const paid = await bare.pay(charge.id, { method: 'cash', amountCents: PRICE });
      const paymentId = paid.json<PaymentResultResponse>().payment.id;
      await bare.api.post(`/billing/cash/sessions/${first.id}/close`, bare.reception, {
        countedCents: 1_100_000,
      });

      const sendRefund = (amountCents: number) =>
        bare.api.post(`/billing/payments/${paymentId}/refund`, bare.owner, {
          amountCents,
          reason: 'Devolución en efectivo',
          idempotencyKey: submissionKey(),
        });
      const withoutRegister = await sendRefund(200_000);
      const second = await bare.openRegister({ openingCents: 50_000 });
      const withRegister = await sendRefund(200_000);

      expect(withoutRegister.statusCode).toBe(409);
      expect(withoutRegister.json<Problem>().code).toBe('cash_register_required');
      expect(withRegister.statusCode, withRegister.body).toBe(201);
      const detail = (
        await bare.api.get(`/billing/cash/sessions/${second.id}`, bare.reception)
      ).json<CashSessionDetailResponse>();
      expect(detail.entries.map((entry) => [entry.kind, entry.amountCents])).toEqual([
        ['refund', 200_000],
      ]);
      expect(detail.session).toMatchObject({
        cashOutCents: 200_000,
        expectedCents: 50_000 - 200_000,
      });
    } finally {
      await bare.close();
    }
  });
});

describe('a correction after the register closed', () => {
  it('reverses the payment and adds the right one in the open register, linked, leaving the closed one unchanged', async () => {
    const bare = await createBillingWorld(runtime, { slug: 'refund-payment-correction' });
    try {
      await bare.setPrice(PRICE);
      const first = await bare.openRegister({ openingCents: 0 });
      const charge = await bare.charge();
      // The desk typed 12.000 instead of 10.000 (with a confirmed credit).
      const wrong = await bare.pay(charge.id, {
        method: 'cash',
        amountCents: 1_200_000,
        confirmCredit: true,
      });
      const wrongId = wrong.json<PaymentResultResponse>().payment.id;
      const closed = await bare.api.post(
        `/billing/cash/sessions/${first.id}/close`,
        bare.reception,
        {
          countedCents: 1_200_000,
        },
      );
      const before = (
        await bare.api.get(`/billing/cash/sessions/${first.id}`, bare.reception)
      ).json<CashSessionDetailResponse>();
      expect(closed.statusCode, closed.body).toBe(200);
      const second = await bare.openRegister({ openingCents: 300_000 });

      const response = await bare.api.post(`/billing/payments/${wrongId}/correct`, bare.owner, {
        amountCents: 1_000_000,
        reason: 'Se tipeó 12.000 en lugar de 10.000',
        idempotencyKey: submissionKey(),
      });

      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<PaymentResultResponse>();
      expect(body.payment).toMatchObject({
        amountCents: 1_000_000,
        correctsPaymentId: wrongId,
        cashSessionId: second.id,
      });
      expect(body.charge).toMatchObject({ status: 'paid', paidCents: 1_000_000, creditCents: 0 });
      const original = body.charge.payments.find((entry) => entry.id === wrongId);
      expect(original).toMatchObject({
        amountCents: 1_200_000,
        netCents: 0,
        reversals: [{ kind: 'correction', amountCents: 1_200_000, cashSessionId: second.id }],
      });
      // The closed register is exactly as it was.
      const after = (
        await bare.api.get(`/billing/cash/sessions/${first.id}`, bare.reception)
      ).json<CashSessionDetailResponse>();
      expect(after).toEqual(before);
      // The open one holds the reversal and the new entry: 300.000 - 1.200.000 + 1.000.000.
      const open = (
        await bare.api.get(`/billing/cash/sessions/${second.id}`, bare.reception)
      ).json<CashSessionDetailResponse>();
      expect(open.entries.map((entry) => [entry.kind, entry.amountCents])).toEqual([
        ['correction', 1_200_000],
        ['payment', 1_000_000],
      ]);
      expect(open.session.expectedCents).toBe(300_000 - 1_200_000 + 1_000_000);
      const [row] = await asTenant(runtime, bare.tenant.id, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(eq(auditEvent.tenantId, bare.tenant.id), eq(auditEvent.action, 'cash.adjusted')),
          )
          .orderBy(desc(auditEvent.occurredAt)),
      );
      expect(row).toMatchObject({
        actorUserId: bare.owner.user.id,
        resourceId: wrongId,
        metadata: { previousAmountCents: 1_200_000, amountCents: 1_000_000 },
      });
    } finally {
      await bare.close();
    }
  });

  it('needs an open register for cash, and a reason, and can be asked again with the same key', async () => {
    const bare = await createBillingWorld(runtime, { slug: 'refund-payment-correction-b' });
    try {
      await bare.setPrice(PRICE);
      const first = await bare.openRegister();
      const charge = await bare.charge();
      const paid = await bare.pay(charge.id, { method: 'cash', amountCents: 800_000 });
      const paymentId = paid.json<PaymentResultResponse>().payment.id;
      await bare.api.post(`/billing/cash/sessions/${first.id}/close`, bare.reception, {
        countedCents: 800_000,
      });
      const key = submissionKey();
      const send = (extra: Record<string, unknown> = {}) =>
        bare.api.post(`/billing/payments/${paymentId}/correct`, bare.owner, {
          amountCents: 900_000,
          reason: 'Importe mal tipeado',
          idempotencyKey: key,
          ...extra,
        });

      const without = await send();
      await bare.openRegister();
      const noReason = await bare.api.post(`/billing/payments/${paymentId}/correct`, bare.owner, {
        amountCents: 900_000,
        idempotencyKey: submissionKey(),
      });
      const done = await send();
      const retry = await send();

      expect(without.statusCode).toBe(409);
      expect(without.json<Problem>().code).toBe('cash_register_required');
      expect(noReason.statusCode).toBe(400);
      expect(done.statusCode, done.body).toBe(201);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json<PaymentResultResponse>().replayed).toBe(true);
      expect(retry.json<PaymentResultResponse>().charge.payments).toHaveLength(2);
    } finally {
      await bare.close();
    }
  });
});
