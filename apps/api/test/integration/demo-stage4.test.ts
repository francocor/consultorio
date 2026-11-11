import { randomBytes } from 'node:crypto';

import type { CashReportResponse, FinancialReportResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../src/db/seed/demo/credentials.js';
import { resetDemoTenant } from '../../src/db/seed/demo/reset.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { readSeededTotals } from '../../src/db/seed/demo/stage4/reports.js';
import { snapshotDemoStage4 } from '../../src/db/seed/demo/stage4/snapshot.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { buildTestApplication } from '../support/app.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { clientFor, signInAs, type TestSession } from '../support/session.js';
import { createTestTenant } from '../support/tenants.js';
import type { TestUser } from '../support/users.js';

/**
 * What the Stage 4 demo seed leaves in a demonstration organization (tasks 4.63 and 4.64; DEM-02,
 * DEM-03, DEM-04, DEM-05): prices and payers, charges in every state, payments of every method, the
 * cash registers of the last days (two with a difference, one open at each desk), and invoices in
 * every state through the in-memory fake. The books are straight, nothing reaches a real fiscal
 * service, two seeds give the same content, a reset takes well under a minute, and the reports add
 * up to the money that was seeded.
 */

/** The requirement is one minute; the CI budget leaves a margin. */
const RESET_LIMIT_MS = 60_000;

let runtime: DbHandle;
let operator: OperatorHarness;
let deps: DemoSeedDeps;
let storage: MemoryObjectStorage;
let app: FastifyInstance;
const clock = () => new Date('2026-03-02T12:00:00Z');
let first: string;
let second: string;

const rows = <T extends Record<string, unknown>>(tenantId: string, query: ReturnType<typeof sql>) =>
  deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const result = await tx.execute<T>(query);
    return result.rows;
  });

const count = async (tenantId: string, query: ReturnType<typeof sql>) =>
  Number((await rows<{ n: string | number }>(tenantId, query))[0]?.n ?? 0);

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  storage = createMemoryObjectStorage();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
    documents: { storage, scanner: createFakeScanner() },
  };
  first = (await createTestTenant(runtime, { slug: 'stage4-a', isDemo: true, billingExempt: true }))
    .id;
  second = (
    await createTestTenant(runtime, { slug: 'stage4-b', isDemo: true, billingExempt: true })
  ).id;
  await seedDemoTenant(deps, first);
  await seedDemoTenant(deps, second);
  app = buildTestApplication(runtime, { keys: deps.keys });
}, 300_000);

afterAll(async () => {
  await app.close();
  await operator.close();
  await runtime.close();
});

describe('the charges of the demonstration organization', () => {
  it('are in every state: pending, partly paid, paid and voided, some of them waiting for a person to look', async () => {
    const byState = await rows<{ status: string; review: boolean; n: number }>(
      first,
      sql`SELECT status, needs_review AS review, count(*)::int AS n FROM charge GROUP BY 1, 2`,
    );

    for (const status of ['pending', 'partially_paid', 'paid', 'voided']) {
      expect(
        byState.filter((entry) => entry.status === status).reduce((sum, entry) => sum + entry.n, 0),
        status,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(byState.some((entry) => entry.review)).toBe(true);
  });

  it('are priced from the list: by a payer, at the private price, and by the fee of a visit that did not happen', async () => {
    const sources = await rows<{ source: string | null }>(
      first,
      sql`SELECT DISTINCT snapshot -> 'quote' ->> 'source' AS source FROM charge`,
    );

    expect(new Set(sources.map((row) => row.source))).toEqual(new Set(['payer', 'private', null]));
    const fees = await count(
      first,
      sql`SELECT count(*)::int AS n FROM charge_line WHERE kind = 'late_fee'`,
    );
    expect(fees).toBeGreaterThan(3);
  });

  it('keep the payer portion apart from what the patient owes', async () => {
    const [portion] = await rows<{ payer: number; patient: number }>(
      first,
      sql`SELECT coalesce(sum(amount_cents) FILTER (WHERE portion = 'payer'), 0)::bigint AS payer,
                 coalesce(sum(amount_cents) FILTER (WHERE portion = 'patient'), 0)::bigint AS patient
            FROM charge_line`,
    );

    expect(Number(portion?.payer)).toBeGreaterThan(0);
    expect(Number(portion?.patient)).toBeGreaterThan(Number(portion?.payer) / 10);
  });
});

describe('the payments and the cash registers', () => {
  it('cover every method, with a refund, a correction and a credit balance', async () => {
    const methods = await rows<{ method: string }>(
      first,
      sql`SELECT DISTINCT method FROM payment ORDER BY 1`,
    );
    const reversals = await rows<{ kind: string }>(
      first,
      sql`SELECT DISTINCT kind FROM payment_reversal ORDER BY 1`,
    );

    expect(methods.map((row) => row.method)).toEqual([
      'cash',
      'credit',
      'debit',
      'payment_link',
      'transfer',
      'wallet',
    ]);
    expect(reversals.map((row) => row.kind)).toEqual(['correction', 'refund']);
    expect(
      await count(first, sql`SELECT count(*)::int AS n FROM payment WHERE credit_cents > 0`),
    ).toBeGreaterThan(0);
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM payment WHERE override_reason IS NOT NULL`,
      ),
    ).toBeGreaterThan(0);
  });

  it('have closed registers, one short and one over, and an open one at every desk of reception', async () => {
    const closed = await rows<{ difference: number | null; reason: string | null }>(
      first,
      sql`SELECT difference_cents::int AS difference, difference_reason AS reason
            FROM cash_session WHERE status = 'closed'`,
    );
    const open = await rows<{ place: string }>(
      first,
      sql`SELECT l.name AS place FROM cash_session s JOIN location l ON l.id = s.location_id
           WHERE s.status = 'open' ORDER BY 1`,
    );

    expect(closed.length).toBeGreaterThanOrEqual(5);
    expect(closed.filter((row) => (row.difference ?? 0) < 0)).toHaveLength(1);
    expect(closed.filter((row) => (row.difference ?? 0) > 0)).toHaveLength(1);
    for (const row of closed.filter((entry) => entry.difference !== 0)) {
      expect(row.reason).toMatch(/\S/);
    }
    expect(open.map((row) => row.place)).toEqual(
      expect.arrayContaining(['Consultorios Norte', 'Sede Central']),
    );
  });

  it('count in a closed register only what the register held (the expected cash is the opening plus cash in minus cash out)', async () => {
    const wrong = await rows<{ id: string }>(
      first,
      sql`SELECT s.id
            FROM cash_session s
            LEFT JOIN LATERAL (
              SELECT coalesce(sum(p.amount_cents), 0) AS cash_in
                FROM payment p WHERE p.cash_session_id = s.id AND p.method = 'cash') pin ON true
            LEFT JOIN LATERAL (
              SELECT coalesce(sum(r.amount_cents), 0) AS cash_out
                FROM payment_reversal r JOIN payment p ON p.id = r.payment_id
               WHERE r.cash_session_id = s.id AND p.method = 'cash') pout ON true
           WHERE s.status = 'closed'
             AND s.expected_cents <> s.opening_cents + pin.cash_in - pout.cash_out`,
    );

    expect(wrong).toEqual([]);
  });
});

describe('the payers and the prices', () => {
  it('have payers with a CUIT, one without it and one switched off, and a price list with history', async () => {
    const payers = await rows<{ code: string | null; cuit: string | null; active: boolean }>(
      first,
      sql`SELECT p.code, t.cuit, t.active FROM tenant_payer t LEFT JOIN payer p ON p.id = t.payer_id ORDER BY 1`,
    );

    expect(payers.find((row) => row.code === 'osde')).toMatchObject({ active: true });
    expect(payers.find((row) => row.code === 'osde')?.cuit).toMatch(/^30\d{9}$/);
    expect(payers.find((row) => row.code === 'galeno')?.cuit).toBeNull();
    expect(payers.find((row) => row.code === 'medife')?.active).toBe(false);
    // Two prices per type: the older list and the current one.
    const [history] = await rows<{ types: number; prices: number }>(
      first,
      sql`SELECT count(DISTINCT appointment_type_id)::int AS types, count(*)::int AS prices FROM price`,
    );
    expect(history?.prices).toBe((history?.types ?? 0) * 2);
  });
});

describe('the invoices', () => {
  it('are in every state: issued, credit notes, rejected (alone, retried and replaced) and registered by hand', async () => {
    const states = await rows<{ type: string; status: string; n: number }>(
      first,
      sql`SELECT type, status, count(*)::int AS n FROM invoice GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const key = (type: string, status: string) =>
      states.find((row) => row.type === type && row.status === status)?.n ?? 0;

    expect(key('FC', 'issued')).toBeGreaterThanOrEqual(8);
    expect(key('NCC', 'issued')).toBe(2);
    expect(key('FC', 'manual')).toBe(1);
    expect(key('FC', 'rejected')).toBeGreaterThanOrEqual(3);
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM invoice WHERE previous_attempt_id IS NOT NULL`,
      ),
    ).toBe(1);
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM invoice WHERE rejection_message LIKE 'Reemplazada%'`,
      ),
    ).toBe(1);
  });

  it('are to patients and to the payers that have a CUIT, never to the one that has none', async () => {
    const recipients = await rows<{ kind: string; code: string | null; n: number }>(
      first,
      sql`SELECT i.recipient_kind AS kind, p.code, count(*)::int AS n
            FROM invoice i
            LEFT JOIN tenant_payer t ON t.id = i.tenant_payer_id
            LEFT JOIN payer p ON p.id = t.payer_id
           WHERE i.credit_note_of_id IS NULL
           GROUP BY 1, 2 ORDER BY 1, 2`,
    );

    expect(recipients.find((row) => row.kind === 'patient')?.n).toBeGreaterThan(5);
    const payerCodes = recipients.filter((row) => row.kind === 'payer').map((row) => row.code);
    expect(payerCodes).toEqual(expect.arrayContaining(['osde']));
    expect(payerCodes).not.toContain('galeno');
  });

  it('number their series in order, and the dates never go back as the numbers grow', async () => {
    const series = await rows<{ type: string; number: number; issue_date: string }>(
      first,
      sql`SELECT type, number::int AS number, issue_date::text AS issue_date
            FROM invoice WHERE number IS NOT NULL ORDER BY type, number`,
    );

    for (const type of ['FC', 'NCC']) {
      const own = series.filter((row) => row.type === type);
      expect(own.map((row) => row.number)).toEqual(own.map((_, index) => index + 1));
      expect(own.map((row) => row.issue_date)).toEqual(
        [...own.map((row) => row.issue_date)].sort(),
      );
    }
  });

  it('have a PDF in storage for every issued voucher, and none for the one registered by hand', async () => {
    const documents = await rows<{ key: string; status: string }>(
      first,
      sql`SELECT d.object_key AS key, i.status
            FROM invoice_document d JOIN invoice i ON i.id = d.invoice_id`,
    );
    const issued = await count(
      first,
      sql`SELECT count(*)::int AS n FROM invoice WHERE status = 'issued'`,
    );

    expect(documents).toHaveLength(issued);
    expect(documents.every((row) => row.status === 'issued')).toBe(true);
    for (const document of documents) expect(storage.keys()).toContain(document.key);
  });

  it('say they are simulated, hold no credential, and use a point of sale in homologation', async () => {
    const real = await rows<{ type: string; status: string }>(
      first,
      sql`SELECT type, status FROM invoice WHERE simulated = false`,
    );

    // The one voucher "made in the web tool of the authority" is the only one that is not simulated.
    expect(real).toEqual([{ type: 'FC', status: 'manual' }]);
    expect(await count(first, sql`SELECT count(*)::int AS n FROM fiscal_credential`)).toBe(0);
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM point_of_sale WHERE environment <> 'homologation'`,
      ),
    ).toBe(0);
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM invoice WHERE status = 'issued' AND environment <> 'homologation'`,
      ),
    ).toBe(0);
  });
});

describe('the books of the seeded organization', () => {
  it('hold every rule of money: no line invoiced above its amount, no refund above its payment, no credit note above its invoice, no payment above the patient portion without a credit', async () => {
    const broken = async (query: ReturnType<typeof sql>) =>
      (await rows<{ id: string }>(first, query)).map((row) => row.id);

    expect(
      await broken(
        sql`SELECT id FROM charge_line WHERE invoiced_cents < 0 OR invoiced_cents > amount_cents`,
      ),
    ).toEqual([]);
    expect(
      await broken(sql`SELECT p.id FROM payment p LEFT JOIN payment_reversal r ON r.payment_id = p.id
                        GROUP BY p.id, p.amount_cents HAVING coalesce(sum(r.amount_cents), 0) > p.amount_cents`),
    ).toEqual([]);
    expect(
      await broken(sql`SELECT i.id FROM invoice i
                        JOIN (SELECT credit_note_of_id AS original, sum(total_cents) AS credited FROM invoice
                               WHERE credit_note_of_id IS NOT NULL AND status <> 'rejected' GROUP BY 1) c
                          ON c.original = i.id WHERE c.credited > i.total_cents`),
    ).toEqual([]);
    expect(
      await broken(sql`SELECT c.id FROM charge c
                        WHERE (SELECT coalesce(sum(p.amount_cents), 0) FROM payment p WHERE p.charge_id = c.id)
                            - (SELECT coalesce(sum(r.amount_cents), 0) FROM payment_reversal r WHERE r.charge_id = c.id)
                            > (SELECT coalesce(sum(l.amount_cents), 0) FROM charge_line l
                                WHERE l.charge_id = c.id AND l.portion = 'patient')
                            + (SELECT coalesce(sum(p.credit_cents), 0) FROM payment p WHERE p.charge_id = c.id)`),
    ).toEqual([]);
  });

  it('leave visits for reception to invoice: paid charges with nothing invoiced yet', async () => {
    const left = await count(
      first,
      sql`SELECT count(*)::int AS n FROM charge c
           WHERE c.status = 'paid'
             AND NOT EXISTS (SELECT 1 FROM charge_line l WHERE l.charge_id = c.id AND l.invoiced_cents > 0)`,
    );

    expect(left).toBeGreaterThanOrEqual(3);
  });
});

describe('the seed is repeatable', () => {
  it('gives two organizations the same logical Stage 4 content', async () => {
    const a = await snapshotDemoStage4(deps.withTenant, first);
    const b = await snapshotDemoStage4(deps.withTenant, second);

    expect(a).toEqual(b);
    expect(a.charges.length).toBeGreaterThan(30);
    expect(a.invoices.length).toBeGreaterThan(15);
    expect(a.registers.length).toBeGreaterThan(5);
  });
});

describe('the reports and the seeded money', () => {
  let owner: TestSession;
  const period = '?from=2026-01-01&to=2026-03-31';

  beforeAll(async () => {
    const account = DEMO_ACCOUNTS.find((entry) => entry.key === 'owner');
    if (!account) throw new Error('no owner account in the demo');
    owner = await signInAs(
      app,
      'stage4-a',
      { email: account.email } as unknown as TestUser,
      DEMO_PASSWORD,
    );
  });

  it('add up to the figures of the tables: charged, voided, collected, outstanding, receivable and invoiced', async () => {
    const seeded = await readSeededTotals(deps.withTenant, first);

    const response = await clientFor(app, 'stage4-a').get(`/reports/financial${period}`, owner);

    expect(response.statusCode, response.body).toBe(200);
    const report = response.json<FinancialReportResponse>();
    expect(report.totals.charged).toEqual({
      count: seeded.charged.count,
      totalCents: seeded.charged.totalCents,
      patientCents: seeded.charged.patientCents,
      payerCents: seeded.charged.payerCents,
    });
    expect(report.totals.voided).toEqual({
      count: seeded.voided.count,
      totalCents: seeded.voided.totalCents,
    });
    expect(report.totals.collected).toMatchObject({
      paymentCount: seeded.payments.count,
      paymentsCents: seeded.payments.cents,
      refundCount: seeded.refunds.count,
      refundsCents: seeded.refunds.cents,
      netCents: seeded.collectedCents,
    });
    expect(report.totals.outstanding).toEqual({
      chargeCount: seeded.outstanding.chargeCount,
      cents: seeded.outstanding.cents,
    });
    expect(report.totals.receivable.cents).toBe(seeded.charged.payerCents);
    expect(report.totals.invoiced).toEqual(seeded.invoiced);
    // A real, wide table: each cut has several rows and adds up to the same total.
    expect(report.byLocation.length).toBeGreaterThanOrEqual(2);
    expect(report.byPayer.length).toBeGreaterThanOrEqual(3);
    for (const cut of [report.byLocation, report.byPayer, report.byType, report.byPeriod]) {
      expect(cut.reduce((sum, row) => sum + row.chargedCents, 0)).toBe(seeded.charged.totalCents);
      expect(cut.reduce((sum, row) => sum + row.paymentsCents, 0)).toBe(seeded.payments.cents);
    }
    expect(report.byMethod.map((row) => row.method).sort()).toEqual([
      'cash',
      'credit',
      'debit',
      'payment_link',
      'transfer',
      'wallet',
    ]);
  });

  it('show the cash of every register: the openings, the count, the differences and the days', async () => {
    const seeded = await readSeededTotals(deps.withTenant, first);

    const response = await clientFor(app, 'stage4-a').get(`/reports/cash${period}`, owner);

    expect(response.statusCode, response.body).toBe(200);
    const report = response.json<CashReportResponse>();
    expect(report.totals.openingCents).toBe(seeded.cash.openingCents);
    expect(report.totals.paymentsCents).toBe(seeded.payments.cents);
    expect(report.totals.refundsCents).toBe(seeded.refunds.cents);
    expect(report.totals.countedCents).toBe(seeded.cash.countedCents);
    expect(report.totals.differenceCents).toBe(seeded.cash.differenceCents);
    expect(report.totals.daysWithDifference).toBe(seeded.cash.sessionsWithDifference);
    const sessions = report.days.flatMap((day) => day.sessions);
    expect(sessions).toHaveLength(seeded.cash.sessions);
    expect(report.days.length).toBeGreaterThanOrEqual(6);
    // The reason of each difference is on the report.
    expect(
      sessions
        .filter((entry) => (entry.differenceCents ?? 0) !== 0)
        .every((entry) => entry.differenceReason),
    ).toBe(true);
  });
});

describe('the reset with Stage 4 data', () => {
  it('finishes in well under a minute and gives back the same content', async () => {
    const before = await snapshotDemoStage4(deps.withTenant, first);

    const started = performance.now();
    await resetDemoTenant({ ...deps, operatorDb: operator.db.db }, first, { operatorId: null });
    const elapsed = performance.now() - started;

    process.stdout.write(`demo reset with Stage 4 data took ${String(Math.round(elapsed))} ms\n`);
    expect(elapsed).toBeLessThan(RESET_LIMIT_MS);
    expect(await snapshotDemoStage4(deps.withTenant, first)).toEqual(before);
  }, 120_000);
});

describe('whatever day the demonstration organization is seeded', () => {
  it('keeps a register open at each desk and invoices to do on a Saturday evening, when nothing is on the agenda', async () => {
    const evening = { ...deps, clock: () => new Date('2026-10-17T21:48:00Z') };
    const id = (
      await createTestTenant(runtime, { slug: 'stage4-evening', isDemo: true, billingExempt: true })
    ).id;

    await seedDemoTenant(evening, id);

    const open = await rows<{ place: string }>(
      id,
      sql`SELECT l.name AS place FROM cash_session s JOIN location l ON l.id = s.location_id WHERE s.status = 'open'`,
    );
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect(await count(id, sql`SELECT count(*)::int AS n FROM charge`)).toBeGreaterThan(30);
    expect(
      await count(id, sql`SELECT count(*)::int AS n FROM invoice WHERE status = 'issued'`),
    ).toBeGreaterThan(5);
  }, 240_000);
});
