import type {
  ChargeDto,
  PaymentResultResponse,
  Problem,
  ReceivablesResponse,
  TenantPayerDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, submissionKey, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * Recording payments (billing-payments, "Payment recording", "Duplicate payment protection"):
 * partial and multiple payments, an overpayment only as a confirmed credit, the payer portion kept
 * apart, and a payment that cannot be recorded twice.
 */

const PRICE = 1_000_000; // 10.000,00

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'record-payment' });
  await world.setPrice(PRICE);
  await world.openRegister({ openingCents: 500_000 });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const read = async (id: string) =>
  (await world.api.get(`/billing/charges/${id}`, world.reception)).json<ChargeDto>();

async function audits(action: 'payment.recorded' | 'payment.override') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('partial and multiple payments', () => {
  it('leaves the charge partially paid with what is still owed, then paid', async () => {
    const charge = await world.charge();

    const first = await world.pay(charge.id, { method: 'cash', amountCents: 400_000 });
    expect(first.statusCode, first.body).toBe(201);
    const afterFirst = first.json<PaymentResultResponse>();
    expect(afterFirst.replayed).toBe(false);
    expect(afterFirst.charge).toMatchObject({
      status: 'partially_paid',
      paidCents: 400_000,
      outstandingCents: 600_000,
      creditCents: 0,
    });
    expect(afterFirst.payment).toMatchObject({
      chargeId: charge.id,
      method: 'cash',
      amountCents: 400_000,
      netCents: 400_000,
      reversedCents: 0,
      recordedBy: world.reception.user.id,
    });

    const second = await world.pay(charge.id, { method: 'debit', amountCents: 600_000 });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<PaymentResultResponse>().charge).toMatchObject({
      status: 'paid',
      paidCents: 1_000_000,
      outstandingCents: 0,
    });
    expect((await read(charge.id)).payments.map((entry) => entry.method)).toEqual([
      'cash',
      'debit',
    ]);
  });

  it('audits who recorded it, how much and how', async () => {
    const charge = await world.charge();

    const response = await world.pay(charge.id, { method: 'transfer', amountCents: 250_000 });

    const [row] = await audits('payment.recorded');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: world.reception.user.id,
      resourceType: 'payment',
      resourceId: response.json<PaymentResultResponse>().payment.id,
      metadata: { chargeId: charge.id, method: 'transfer', amountCents: 250_000 },
    });
  });

  it('shows the non-cash payment in the register for the daily summary, and cash always', async () => {
    const charge = await world.charge();
    const register = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.reception,
    );
    const sessionId = register.json<{ session: { id: string } }>().session.id;

    const cash = await world.pay(charge.id, { method: 'cash', amountCents: 100_000 });
    const card = await world.pay(charge.id, { method: 'credit', amountCents: 100_000 });

    expect(cash.json<PaymentResultResponse>().payment.cashSessionId).toBe(sessionId);
    expect(card.json<PaymentResultResponse>().payment.cashSessionId).toBe(sessionId);
  });
});

describe('the cash register is required for cash', () => {
  it('refuses cash while the location has no open register, and takes other methods', async () => {
    const bare = await createBillingWorld(runtime, { slug: 'record-payment-bare' });
    try {
      await bare.setPrice(PRICE);
      const charge = await bare.charge();

      const cash = await bare.pay(charge.id, { method: 'cash', amountCents: 100_000 });
      const card = await bare.pay(charge.id, { method: 'debit', amountCents: 100_000 });

      expect(cash.statusCode).toBe(409);
      expect(cash.json<Problem>().code).toBe('cash_register_required');
      expect(card.statusCode, card.body).toBe(201);
      expect(card.json<PaymentResultResponse>().payment.cashSessionId).toBeNull();
      expect(
        (await bare.api.get(`/billing/charges/${charge.id}`, bare.reception)).json<ChargeDto>()
          .payments,
      ).toHaveLength(1);

      await bare.openRegister();
      const retried = await bare.pay(charge.id, { method: 'cash', amountCents: 100_000 });
      expect(retried.statusCode, retried.body).toBe(201);
    } finally {
      await bare.close();
    }
  });
});

describe('overpayment', () => {
  it('is refused until a person confirms the credit balance', async () => {
    const charge = await world.charge();
    await world.pay(charge.id, { method: 'debit', amountCents: 700_000 });

    const refused = await world.pay(charge.id, { method: 'debit', amountCents: 500_000 });

    expect(refused.statusCode).toBe(409);
    expect(refused.json<Problem>().code).toBe('payment_overpayment');
    expect((await read(charge.id)).paidCents).toBe(700_000);
  });

  it('keeps the excess as a credit balance when confirmed, and never marks the charge overpaid', async () => {
    const charge = await world.charge();
    await world.pay(charge.id, { method: 'debit', amountCents: 700_000 });

    const confirmed = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 500_000,
      confirmCredit: true,
    });

    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const body = confirmed.json<PaymentResultResponse>();
    expect(body.payment.creditCents).toBe(200_000);
    expect(body.charge).toMatchObject({
      status: 'paid',
      paidCents: 1_200_000,
      outstandingCents: 0,
      creditCents: 200_000,
    });
  });

  it('treats any payment on a charge that is already paid as an overpayment', async () => {
    const charge = await world.charge();
    await world.pay(charge.id, { method: 'debit', amountCents: PRICE });

    const response = await world.pay(charge.id, { method: 'debit', amountCents: 1_000 });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('payment_overpayment');
  });
});

describe('the payer portion is not a patient payment', () => {
  it('settles the patient side when the copago is paid and leaves the payer portion receivable', async () => {
    const osdeId = await world.catalogPayer('record-payment-osde', 'OSDE Pagos');
    const osde = (
      await world.api.post('/billing/payers', world.owner, { payerId: osdeId })
    ).json<TenantPayerDto>();
    await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: osde.id,
      appointmentTypeId: world.consulta,
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 0,
      effectiveFrom: '2031-01-01',
    });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeId });
    const charge = await world.charge({ patientId });
    expect(charge).toMatchObject({ patientCents: 300_000, payerCents: 1_500_000 });

    const tooMuch = await world.pay(charge.id, { method: 'debit', amountCents: 1_800_000 });
    const paid = await world.pay(charge.id, { method: 'debit', amountCents: 300_000 });

    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json<Problem>().code).toBe('payment_overpayment');
    expect(paid.json<PaymentResultResponse>().charge).toMatchObject({
      status: 'paid',
      paidCents: 300_000,
      payerCents: 1_500_000,
      outstandingCents: 0,
    });
    const owed = (
      await world.api.get('/billing/receivables', world.owner)
    ).json<ReceivablesResponse>();
    const group = owed.groups.find((entry) => entry.tenantPayerId === osde.id);
    expect(group).toMatchObject({ payerName: 'OSDE Pagos', totalCents: 1_500_000 });
    expect(group?.items.map((item) => item.chargeId)).toContain(charge.id);
  });
});

describe('a payment is recorded once', () => {
  it('answers a retried submission with the same payment, replayed, and records one', async () => {
    const charge = await world.charge();
    const body = { method: 'debit', amountCents: 500_000, idempotencyKey: submissionKey() };

    const first = await world.pay(charge.id, body);
    const retry = await world.pay(charge.id, body);

    expect(first.statusCode, first.body).toBe(201);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json<PaymentResultResponse>()).toMatchObject({ replayed: true });
    expect(retry.json<PaymentResultResponse>().payment.id).toBe(
      first.json<PaymentResultResponse>().payment.id,
    );
    const after = await read(charge.id);
    expect(after.payments).toHaveLength(1);
    expect(after.paidCents).toBe(500_000);
  });

  it('records exactly one payment when the same submission arrives twice at once', async () => {
    const charge = await world.charge();
    const body = { method: 'debit', amountCents: 400_000, idempotencyKey: submissionKey() };

    const [one, two] = await Promise.all([world.pay(charge.id, body), world.pay(charge.id, body)]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 201]);
    expect((await read(charge.id)).payments).toHaveLength(1);
  });

  it('refuses a key that was used for a different payment', async () => {
    const charge = await world.charge();
    const idempotencyKey = submissionKey();
    await world.pay(charge.id, { method: 'debit', amountCents: 100_000, idempotencyKey });

    const other = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 200_000,
      idempotencyKey,
    });
    const elsewhere = await world.pay((await world.charge()).id, {
      method: 'debit',
      amountCents: 100_000,
      idempotencyKey,
    });

    expect(other.statusCode).toBe(409);
    expect(other.json<Problem>().code).toBe('idempotency_key_reused');
    expect(elsewhere.json<Problem>().code).toBe('idempotency_key_reused');
    expect((await read(charge.id)).payments).toHaveLength(1);
  });

  it('records two payments of the same amount that carry different keys', async () => {
    const charge = await world.charge();

    await world.pay(charge.id, { method: 'debit', amountCents: 100_000 });
    await world.pay(charge.id, { method: 'debit', amountCents: 100_000 });

    expect((await read(charge.id)).payments).toHaveLength(2);
  });
});

describe('the same voucher twice', () => {
  it('warns and requires an audited override with a reason', async () => {
    const charge = await world.charge();
    const first = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: '004512',
    });

    const again = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: '004512',
    });
    const overridden = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: '004512',
      overrideReason: 'Dos cuotas con el mismo comprobante',
    });
    const other = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: '004513',
    });

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(409);
    expect(again.json<Problem>().code).toBe('payment_voucher_duplicate');
    expect(overridden.statusCode, overridden.body).toBe(201);
    expect(overridden.json<PaymentResultResponse>().payment.overrideReason).toBe(
      'Dos cuotas con el mismo comprobante',
    );
    expect(other.statusCode).toBe(201);
    const [row] = await audits('payment.override');
    expect(row).toMatchObject({
      actorUserId: world.reception.user.id,
      resourceId: overridden.json<PaymentResultResponse>().payment.id,
      metadata: { reason: 'Dos cuotas con el mismo comprobante' },
    });
  });

  it('does not refuse a repeated voucher that is not repeated (a first one with a reason is plain)', async () => {
    const charge = await world.charge();

    const response = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: 'UNICO-1',
      overrideReason: 'Por las dudas',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<PaymentResultResponse>().payment.overrideReason).toBeNull();
  });

  it('refuses a reference that is only a card number', async () => {
    const charge = await world.charge();

    const response = await world.pay(charge.id, {
      method: 'credit',
      amountCents: 100_000,
      externalRef: '4111 1111 1111 1111',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('who may record, and on what', () => {
  it('denies the professional, who may read but not charge', async () => {
    const charge = await world.charge();

    const response = await world.pay(
      charge.id,
      { method: 'debit', amountCents: 100_000 },
      world.doctor,
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a voided charge', async () => {
    const charge = await world.charge();
    await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });

    const response = await world.pay(charge.id, { method: 'debit', amountCents: 100_000 });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('charge_voided');
  });

  it('answers not found for a charge that does not exist', async () => {
    const response = await world.pay('0190a000-0000-7000-8000-0000000000aa', {
      method: 'debit',
      amountCents: 100,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a float, a zero, a date and an author sent by the client', async () => {
    const charge = await world.charge();

    for (const extra of [
      { amountCents: 100.5 },
      { amountCents: 0 },
      { paidAt: '2031-05-12T10:00:00Z' },
      { recordedBy: world.owner.user.id },
    ]) {
      const response = await world.pay(charge.id, { method: 'debit', amountCents: 100, ...extra });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('is refused with 402 while the organization is read-only, and reads keep working', async () => {
    const charge = await world.charge();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      const refused = await world.pay(charge.id, { method: 'debit', amountCents: 100_000 });
      const read = await world.api.get(`/billing/charges/${charge.id}`, world.reception);

      expect(refused.statusCode).toBe(402);
      expect(refused.json<Problem>().code).toBe('tenant_read_only');
      expect(read.statusCode).toBe(200);
    } finally {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });
});

describe('voiding a charge that has payments', () => {
  it('requires the payment to be refunded first', async () => {
    const charge = await world.charge();
    const paid = await world.pay(charge.id, { method: 'debit', amountCents: 300_000 });
    const paymentId = paid.json<PaymentResultResponse>().payment.id;

    const refused = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Se cargó por error',
    });
    const refund = await world.api.post(`/billing/payments/${paymentId}/refund`, world.owner, {
      amountCents: 300_000,
      reason: 'Devolución total antes de anular',
      idempotencyKey: submissionKey(),
    });
    const voided = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Se cargó por error',
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json<Problem>().code).toBe('charge_has_payments');
    expect(refund.statusCode, refund.body).toBe(201);
    expect(voided.statusCode, voided.body).toBe(200);
  });
});
