import type {
  CashSessionDetailResponse,
  CashSessionDto,
  CashSessionListResponse,
  PaymentResultResponse,
  Problem,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, submissionKey, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * The daily cash register per location (billing-payments, "Daily cash register per location",
 * "Closed register immutability"): open with cash, take cash and other methods, close with what was
 * counted; one at a time; closed means closed.
 */

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'cash-register' });
  await world.setPrice(1_500_000);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const close = (id: string, body: Record<string, unknown>, by = world.reception) =>
  world.api.post(`/billing/cash/sessions/${id}/close`, by, body);

async function audits(action: 'cash.opened' | 'cash.closed' | 'access.denied') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

/** Takes `amountCents` in cash for a new charge (one charge of 15.000 per call, paid in part). */
async function takeCash(amountCents: number, method = 'cash') {
  const charge = await world.charge();
  const response = await world.pay(charge.id, { method, amountCents });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PaymentResultResponse>();
}

describe('opening and closing the day', () => {
  it('expects the opening cash plus the cash taken, and closes with no difference when it matches', async () => {
    const opened = await world.openRegister({ openingCents: 500_000 });
    expect(opened).toMatchObject({
      status: 'open',
      openingCents: 500_000,
      expectedCents: 500_000,
      locationName: 'Centro',
      closedAt: null,
    });
    await takeCash(1_200_000);
    await takeCash(1_000_000);
    await takeCash(800_000, 'debit');

    const closed = await close(opened.id, { countedCents: 2_700_000 });

    expect(closed.statusCode, closed.body).toBe(200);
    const session = closed.json<CashSessionDto>();
    expect(session).toMatchObject({
      status: 'closed',
      expectedCents: 2_700_000,
      countedCents: 2_700_000,
      differenceCents: 0,
      differenceReason: null,
      closedBy: world.reception.user.id,
      cashInCents: 2_200_000,
      cashOutCents: 0,
    });
    expect(session.closedAt).not.toBeNull();
    expect(session.byMethod).toEqual([
      { method: 'cash', count: 2, paymentsCents: 2_200_000, refundsCents: 0, netCents: 2_200_000 },
      { method: 'debit', count: 1, paymentsCents: 800_000, refundsCents: 0, netCents: 800_000 },
    ]);
    const [opening] = await audits('cash.opened');
    const [closing] = await audits('cash.closed');
    expect(opening).toMatchObject({
      actorUserId: world.reception.user.id,
      resourceId: opened.id,
      metadata: { locationId: world.centro, openingCents: 500_000 },
    });
    expect(closing).toMatchObject({
      actorUserId: world.reception.user.id,
      resourceId: opened.id,
      metadata: { expectedCents: 2_700_000, countedCents: 2_700_000, differenceCents: 0 },
    });
  });

  it('needs a reason for a difference, and stores it with the closing', async () => {
    const opened = await world.openRegister({ openingCents: 500_000 });
    await takeCash(1_500_000);
    await takeCash(1_500_000);
    // Expected: 5.000 + 30.000 = 35.000. Counted: 34.000.

    const bare = await close(opened.id, { countedCents: 3_400_000 });
    const withReason = await close(opened.id, {
      countedCents: 3_400_000,
      differenceReason: 'Falta un billete de 1.000',
    });

    expect(bare.statusCode).toBe(422);
    expect(bare.json<Problem>().code).toBe('cash_difference_reason_required');
    expect(withReason.statusCode, withReason.body).toBe(200);
    expect(withReason.json<CashSessionDto>()).toMatchObject({
      expectedCents: 3_500_000,
      countedCents: 3_400_000,
      differenceCents: -100_000,
      differenceReason: 'Falta un billete de 1.000',
    });
    const [closing] = await audits('cash.closed');
    expect(closing?.metadata).toMatchObject({
      differenceCents: -100_000,
      reason: 'Falta un billete de 1.000',
    });
  });

  it('accepts a surplus with its reason too', async () => {
    const opened = await world.openRegister();
    const closed = await close(opened.id, {
      countedCents: 50_000,
      differenceReason: 'Propina dejada en la caja',
    });

    expect(closed.json<CashSessionDto>()).toMatchObject({ differenceCents: 50_000 });
  });
});

describe('one register at a time', () => {
  it('refuses a second opening at the location and points at the one that is open', async () => {
    const opened = await world.openRegister({ openingCents: 100_000 });

    const second = await world.api.post('/billing/cash/sessions', world.admin, {
      locationId: world.centro,
      openingCents: 0,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json<Problem & { existingSessionId: string }>()).toMatchObject({
      code: 'conflict',
      existingSessionId: opened.id,
    });
    await close(opened.id, { countedCents: 100_000 });
    const afterClosing = await world.api.post('/billing/cash/sessions', world.admin, {
      locationId: world.centro,
      openingCents: 0,
    });
    expect(afterClosing.statusCode, afterClosing.body).toBe(201);
    await close(afterClosing.json<CashSessionDto>().id, { countedCents: 0 });
  });

  it('opens exactly one when two openings arrive together', async () => {
    const [one, two] = await Promise.all([
      world.api.post('/billing/cash/sessions', world.reception, {
        locationId: world.centro,
        openingCents: 0,
      }),
      world.api.post('/billing/cash/sessions', world.admin, {
        locationId: world.centro,
        openingCents: 0,
      }),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    const current = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.reception,
    );
    await close(current.json<{ session: CashSessionDto }>().session.id, { countedCents: 0 });
  });

  it('keeps the register of each location apart', async () => {
    const centro = await world.openRegister({ locationId: world.centro, openingCents: 10_000 });
    const norte = await world.openRegister({
      locationId: world.norte,
      openingCents: 20_000,
      by: world.owner,
    });

    expect(centro.locationId).not.toBe(norte.locationId);
    const here = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.reception,
    );
    expect(here.json<{ session: CashSessionDto }>().session.id).toBe(centro.id);
    await close(centro.id, { countedCents: 10_000 });
    await close(norte.id, { countedCents: 20_000 }, world.owner);
  });
});

describe('cash with no open register', () => {
  it('is refused and the desk is told to open one; the current register is null', async () => {
    const charge = await world.charge();

    const refused = await world.pay(charge.id, { method: 'cash', amountCents: 100_000 });
    const current = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.reception,
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.json<Problem>().code).toBe('cash_register_required');
    expect(current.json<{ session: CashSessionDto | null }>().session).toBeNull();
  });
});

describe('a closed register', () => {
  it('cannot be closed again, takes no entries and keeps its figures', async () => {
    const opened = await world.openRegister({ openingCents: 200_000 });
    await takeCash(300_000);
    const closed = await close(opened.id, { countedCents: 500_000 });
    const before = (
      await world.api.get(`/billing/cash/sessions/${opened.id}`, world.reception)
    ).json<CashSessionDetailResponse>();

    const again = await close(opened.id, { countedCents: 1 });
    const charge = await world.charge();
    const cash = await world.pay(charge.id, { method: 'cash', amountCents: 100_000 });
    const card = await world.pay(charge.id, { method: 'debit', amountCents: 100_000 });
    const after = (
      await world.api.get(`/billing/cash/sessions/${opened.id}`, world.reception)
    ).json<CashSessionDetailResponse>();

    expect(closed.statusCode).toBe(200);
    expect(again.statusCode).toBe(409);
    expect(again.json<Problem>().code).toBe('cash_register_closed');
    expect(cash.json<Problem>().code).toBe('cash_register_required');
    // A card payment is not tied to a register that is closed.
    expect(card.json<PaymentResultResponse>().payment.cashSessionId).toBeNull();
    expect(after).toEqual(before);
  });

  it('cannot be changed by the application role, in the database', async () => {
    const opened = await world.openRegister();
    await close(opened.id, { countedCents: 0 });

    const error = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.transaction((inner) =>
        inner.execute(sql`UPDATE cash_session SET counted_cents = 999 WHERE id = ${opened.id}`),
      ),
    ).then(
      () => undefined,
      (failure: unknown) => (failure as { cause?: { code?: string } }).cause?.code,
    );

    expect(error).toBe('42501');
  });
});

describe('who may operate which register', () => {
  it('limits reception to its locations: the other one answers like it does not exist', async () => {
    const open = await world.api.post('/billing/cash/sessions', world.reception, {
      locationId: world.norte,
      openingCents: 0,
    });
    const current = await world.api.get(
      `/billing/cash/current?locationId=${world.norte}`,
      world.reception,
    );
    const norteOwned = await world.openRegister({ locationId: world.norte, by: world.owner });
    const detail = await world.api.get(`/billing/cash/sessions/${norteOwned.id}`, world.reception);
    const closing = await close(norteOwned.id, { countedCents: 0 }, world.reception);
    const listed = (
      await world.api.get('/billing/cash/sessions', world.reception)
    ).json<CashSessionListResponse>();
    const everything = (
      await world.api.get('/billing/cash/sessions', world.owner)
    ).json<CashSessionListResponse>();

    expect([open.statusCode, current.statusCode, detail.statusCode, closing.statusCode]).toEqual([
      404, 404, 404, 404,
    ]);
    expect(listed.sessions.every((entry) => entry.locationId === world.centro)).toBe(true);
    expect(everything.sessions.some((entry) => entry.locationId === world.norte)).toBe(true);
    await close(norteOwned.id, { countedCents: 0 }, world.owner);
  });

  it('denies a professional the register unless it was granted, and then only at their locations', async () => {
    const before = (await audits('access.denied')).length;

    const denied = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.doctor,
    );
    await world.grantPermission(world.doctor, 'cash.operate');
    const granted = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.doctor,
    );
    await world.revokePermission(world.doctor, 'cash.operate');

    expect(denied.statusCode).toBe(403);
    expect((await audits('access.denied')).length).toBe(before + 1);
    // The grant opens the permission, not the places: the doctor works at none of them.
    expect(granted.statusCode).toBe(404);
  });

  it('lets an administrator close a register that reception opened', async () => {
    const opened = await world.openRegister({ openingCents: 0 });

    const closed = await close(opened.id, { countedCents: 0 }, world.admin);

    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<CashSessionDto>().closedBy).toBe(world.admin.user.id);
  });

  it('rejects a fraction, a negative amount and a made-up expected figure', async () => {
    const opened = await world.openRegister();

    const bodies = [
      { countedCents: 10.5 },
      { countedCents: -1 },
      { countedCents: 0, expectedCents: 1 },
    ];
    for (const body of bodies) {
      const response = await close(opened.id, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const open = await world.api.post('/billing/cash/sessions', world.owner, {
      locationId: world.centro,
      openingCents: -5,
    });
    expect(open.statusCode).toBe(400);
    await close(opened.id, { countedCents: 0 });
  });
});

describe('the list', () => {
  it('filters by state and place, newest first', async () => {
    const open = await world.openRegister({ openingCents: 1 });

    const onlyOpen = (
      await world.api.get(
        `/billing/cash/sessions?status=open&locationId=${world.centro}`,
        world.reception,
      )
    ).json<CashSessionListResponse>();
    const onlyClosed = (
      await world.api.get('/billing/cash/sessions?status=closed', world.reception)
    ).json<CashSessionListResponse>();

    expect(onlyOpen.sessions.map((entry) => entry.id)).toEqual([open.id]);
    expect(onlyClosed.sessions.length).toBeGreaterThan(2);
    expect(onlyClosed.sessions.every((entry) => entry.status === 'closed')).toBe(true);
    const times = onlyClosed.sessions.map((entry) => entry.openedAt);
    expect([...times].sort().reverse()).toEqual(times);
    await close(open.id, { countedCents: 1 });
    // Keep the helper honest: a key is unique each time.
    expect(submissionKey()).not.toBe(submissionKey());
  });
});
