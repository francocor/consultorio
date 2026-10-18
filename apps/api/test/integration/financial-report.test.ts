import type {
  CashReportResponse,
  CashSessionDetailResponse,
  ChargeDto,
  FinancialRecordKind,
  FinancialRecordsResponse,
  FinancialReportResponse,
  PaymentResultResponse,
  Problem,
  ReportOptionsResponse,
  TenantPayerDto,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { chargeFacts } from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The financial and cash reports (reports-dashboard, S4.14): every money figure reproduces from the
 * charges, payments, refunds, vouchers and registers behind it, for the same filters, and each role
 * reads only what it may. The data is made through the API, the way the screens make it, and then
 * the money is dated on the day of its service (the billing clock is the real one; the services
 * are in May 2031) with the owner connection, which is the only thing a test cannot do through the API.
 */

let runtime: DbHandle;
let world: InvoicingWorld;
let osde: TenantPayerDto;
const charges: Record<'c1' | 'c2' | 'c3' | 'c4' | 'c5', ChargeDto> = {} as never;
let centroRegister: string;

const MAY = { from: '2031-05-01', to: '2031-05-31' };
const idempotency = (n: number) => `0190a000-0000-7000-8000-${String(900 + n).padStart(12, '0')}`;

async function asDatabaseOwner(run: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: inject('adminUrl') });
  await client.connect();
  try {
    // Without the triggers that keep a payment, a voucher or a register from being edited.
    await client.query("SET session_replication_role = 'replica'");
    await run(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'financial-report' });

  const osdeCatalogId = await world.catalogPayer('financial-report-osde', 'OSDE Finanzas');
  osde = (
    await world.api.post('/billing/payers', world.owner, { payerId: osdeCatalogId })
  ).json<TenantPayerDto>();
  await world.api.post('/billing/payer-prices', world.owner, {
    tenantPayerId: osde.id,
    appointmentTypeId: world.consulta,
    payerAmountCents: 1_500_000,
    copagoCents: 300_000,
    plusCents: 0,
    effectiveFrom: '2031-01-01',
  });

  // The second professional also works at Norte, on Tuesdays.
  const hours = await world.api.put(
    `/professionals/${world.colleague.professionalId}/hours`,
    world.colleague,
    {
      hours: [
        { locationId: world.centro, weekday: 1, start: '09:00', end: '13:00' },
        { locationId: world.norte, weekday: 2, start: '09:00', end: '13:00' },
      ],
    },
  );
  expect(hours.statusCode, hours.body).toBe(200);

  centroRegister = (await world.openRegister({ openingCents: 1_000_000 })).id;
  const norteRegister = await world.openRegister({
    locationId: world.norte,
    openingCents: 500_000,
    by: world.owner,
  });
  expect(norteRegister.status).toBe('open');

  // C1: 100000 ARS (the consultation and 80000 of material), invoiced, with a credit note of 20000,
  // paid 60000 in cash.
  charges.c1 = await world.charge();
  await world.api.post(`/billing/charges/${charges.c1.id}/lines`, world.reception, {
    description: 'Material',
    amountCents: 8_000_000,
  });
  const invoice = await world.issueInvoiceOf(charges.c1);
  expect(invoice.totalCents).toBe(10_000_000);
  const note = await world.creditNote(invoice.id, { amountCents: 2_000_000 });
  expect(note.statusCode, note.body).toBe(202);
  await world.runIssue();
  const paidC1 = await world.pay(charges.c1.id, { method: 'cash', amountCents: 6_000_000 });
  expect(paidC1.statusCode, paidC1.body).toBe(201);

  // C2: 20000, paid in full by debit card, 5000 of it refunded.
  charges.c2 = await world.charge();
  const paidC2 = await world.pay(charges.c2.id, { method: 'debit', amountCents: 2_000_000 });
  const refund = await world.api.post(
    `/billing/payments/${paidC2.json<PaymentResultResponse>().payment.id}/refund`,
    world.owner,
    { amountCents: 500_000, reason: 'Devolución parcial', idempotencyKey: idempotency(1) },
  );
  expect(refund.statusCode, refund.body).toBe(201);

  // C3: 20000, voided.
  charges.c3 = await world.charge();
  const voided = await world.api.post(`/billing/charges/${charges.c3.id}/void`, world.owner, {
    reason: 'Cargado por error',
  });
  expect(voided.statusCode, voided.body).toBe(200);

  // C4: a patient of OSDE with the second professional: 15000 for the payer, 3000 for the patient.
  const covered = await world.freshPatient();
  await world.cover(covered, { payerId: osdeCatalogId });
  const appointment = await world.appointment({
    patientId: covered,
    professional: world.colleague,
  });
  const captured = await world.api.post('/billing/charges', world.reception, {
    appointmentId: appointment.id,
  });
  expect(captured.statusCode, captured.body).toBe(201);
  charges.c4 = captured.json<ChargeDto>();

  // C5: 20000 at Norte (reception does not work there), paid by transfer.
  const norteDay = new Date(Date.parse(`${world.monday(0)}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const norteVisit = await world.book(
    0,
    '09:00',
    {
      professionalId: world.colleague.professionalId,
      locationId: world.norte,
      local: { date: norteDay, time: '09:00' },
    },
    world.owner,
  );
  expect((await world.act(norteVisit, 'check-in', world.owner)).statusCode).toBe(200);
  const norteCharge = await world.api.post('/billing/charges', world.owner, {
    appointmentId: norteVisit.id,
  });
  expect(norteCharge.statusCode, norteCharge.body).toBe(201);
  charges.c5 = norteCharge.json<ChargeDto>();
  const paidC5 = await world.pay(
    charges.c5.id,
    { method: 'transfer', amountCents: 2_000_000 },
    world.owner,
  );
  expect(paidC5.statusCode, paidC5.body).toBe(201);

  // The centre closes its register 1000 ARS short.
  const detail = (
    await world.api.get(`/billing/cash/sessions/${centroRegister}`, world.reception)
  ).json<CashSessionDetailResponse>();
  const closed = await world.api.post(
    `/billing/cash/sessions/${centroRegister}/close`,
    world.reception,
    {
      countedCents: detail.session.expectedCents - 100_000,
      differenceReason: 'Faltante de vuelto',
    },
  );
  expect(closed.statusCode, closed.body).toBe(200);

  // Money is dated on the day of its service; registers on the day after the first service.
  await asDatabaseOwner(async (client) => {
    await client.query(
      `UPDATE payment SET paid_at = ((ch.snapshot ->> 'serviceDate')::timestamp + interval '18 hours') AT TIME ZONE 'UTC'
         FROM charge ch WHERE ch.id = payment.charge_id AND payment.tenant_id = $1`,
      [world.tenant.id],
    );
    await client.query(
      `UPDATE payment_reversal SET reversed_at = ((ch.snapshot ->> 'serviceDate')::timestamp + interval '19 hours') AT TIME ZONE 'UTC'
         FROM charge ch WHERE ch.id = payment_reversal.charge_id AND payment_reversal.tenant_id = $1`,
      [world.tenant.id],
    );
    await client.query(`UPDATE invoice SET issue_date = '2031-05-20' WHERE tenant_id = $1`, [
      world.tenant.id,
    ]);
    await client.query(
      `UPDATE cash_session SET opened_at = '2031-05-13T12:00:00Z',
              closed_at = CASE WHEN status = 'closed' THEN '2031-05-13T21:00:00Z'::timestamptz END
        WHERE tenant_id = $1`,
      [world.tenant.id],
    );
  });
}, 180_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const query = (filters: Record<string, string>) => `?${new URLSearchParams(filters).toString()}`;

async function financial(
  session: Parameters<typeof world.api.get>[1],
  filters: Record<string, string> = MAY,
) {
  const response = await world.api.get(`/reports/financial${query(filters)}`, session);
  return { response, body: response.json<FinancialReportResponse>() };
}

async function records(
  session: Parameters<typeof world.api.get>[1],
  kind: FinancialRecordKind,
  filters: Record<string, string> = MAY,
  paging: Record<string, string> = {},
) {
  const response = await world.api.get(
    `/reports/financial/records${query({ ...filters, kind, ...paging })}`,
    session,
  );
  return { response, body: response.json<FinancialRecordsResponse>() };
}

async function cash(
  session: Parameters<typeof world.api.get>[1],
  filters: Record<string, string> = MAY,
) {
  const response = await world.api.get(`/reports/cash${query(filters)}`, session);
  return { response, body: response.json<CashReportResponse>() };
}

/** Every record of a kind, read two at a time so the pages have to join up. */
async function allRecords(
  session: Parameters<typeof world.api.get>[1],
  kind: FinancialRecordKind,
  filters: Record<string, string> = MAY,
) {
  const rows: FinancialRecordsResponse['records'] = [];
  let total = 0;
  let sumCents = 0;
  for (let offset = 0; offset < 40; offset += 2) {
    const { response, body } = await records(session, kind, filters, {
      limit: '2',
      offset: String(offset),
    });
    expect(response.statusCode, response.body).toBe(200);
    total = body.total;
    sumCents = body.sumCents;
    rows.push(...body.records);
    if (rows.length >= body.total) break;
  }
  return { rows, total, sumCents };
}

const sumOf = <T>(rows: readonly T[], field: (row: T) => number) =>
  rows.reduce((total, row) => total + field(row), 0);

describe('the money figures of a month (the spec scenarios)', () => {
  it('nets an invoice of 100000 and a credit note of 20000 to 80000', async () => {
    const { response, body } = await financial(world.owner);

    expect(response.statusCode, response.body).toBe(200);
    expect(body.totals.invoiced).toEqual({
      invoicedCents: 10_000_000,
      creditedCents: 2_000_000,
      netCents: 8_000_000,
      documents: 2,
    });
  });

  it('leaves a voided charge out of what was charged and shows it apart', async () => {
    const { body } = await financial(world.owner);

    expect(body.totals.voided).toEqual({ count: 1, totalCents: 2_000_000 });
    // 100000 + 20000 + 18000 + 20000: the voided 20000 is not in it.
    expect(body.totals.charged).toEqual({
      count: 4,
      totalCents: 15_800_000,
      patientCents: 14_300_000,
      payerCents: 1_500_000,
    });
  });

  it('shows what was collected with the refund as a reduction, and what is still owed', async () => {
    const { body } = await financial(world.owner);

    expect(body.totals.collected).toEqual({
      paymentCount: 3,
      paymentsCents: 10_000_000,
      refundCount: 1,
      refundsCents: 500_000,
      netCents: 9_500_000,
    });
    // 40000 of the first, 5000 of the second and 3000 of the patient of OSDE; the Norte one is settled.
    expect(body.totals.outstanding).toEqual({ chargeCount: 3, cents: 4_800_000 });
    expect(body.totals.receivable).toEqual({ cents: 1_500_000 });
  });

  it('reproduces from the charges the way billing lists them', async () => {
    const listed = await world.api.get(
      `/billing/charges?from=2031-05-01&to=2031-05-31`,
      world.owner,
    );
    const live = listed
      .json<{ charges: ChargeDto[] }>()
      .charges.filter((c) => c.status !== 'voided');
    const { body } = await financial(world.owner);

    expect(sumOf(live, (charge) => charge.totalCents)).toBe(body.totals.charged.totalCents);
    expect(sumOf(live, (charge) => charge.outstandingCents)).toBe(body.totals.outstanding.cents);
    expect(sumOf(live, (charge) => charge.paidCents)).toBe(body.totals.collected.netCents);
  });

  it('adds up the same total in every breakdown', async () => {
    const { body } = await financial(world.owner);

    const dimensions = {
      period: body.byPeriod,
      location: body.byLocation,
      professional: body.byProfessional ?? [],
      payer: body.byPayer,
      type: body.byType,
    };
    for (const [name, rows] of Object.entries(dimensions)) {
      expect(
        sumOf(rows, (row) => row.chargedCents),
        `${name} charged`,
      ).toBe(15_800_000);
      expect(
        sumOf(rows, (row) => row.voidedCents),
        `${name} voided`,
      ).toBe(2_000_000);
      expect(
        sumOf(rows, (row) => row.paymentsCents),
        `${name} payments`,
      ).toBe(10_000_000);
      expect(
        sumOf(rows, (row) => row.refundsCents),
        `${name} refunds`,
      ).toBe(500_000);
      expect(
        sumOf(rows, (row) => row.collectedCents),
        `${name} collected`,
      ).toBe(9_500_000);
      expect(
        sumOf(rows, (row) => row.outstandingCents),
        `${name} outstanding`,
      ).toBe(4_800_000);
      expect(
        sumOf(rows, (row) => row.receivableCents),
        `${name} receivable`,
      ).toBe(1_500_000);
    }
    for (const name of ['period', 'location', 'professional', 'payer'] as const) {
      expect(
        sumOf(dimensions[name], (row) => row.invoicedNetCents ?? 0),
        `${name} invoiced`,
      ).toBe(8_000_000);
    }
    // A voucher does not say the appointment type: nothing is reported for it, not even zero.
    expect(body.byType.every((row) => row.invoicedNetCents === null)).toBe(true);
  });

  it('cuts by location, professional and payer with their names', async () => {
    const { body } = await financial(world.owner);

    expect(body.byLocation.map((row) => [row.label, row.chargedCents])).toEqual([
      ['Centro', 13_800_000],
      ['Norte', 2_000_000],
    ]);
    expect(
      body.byProfessional
        ?.map((row) => [row.key, row.chargedCents])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        [world.doctor.professionalId, 12_000_000],
        [world.colleague.professionalId, 3_800_000],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(body.byPayer.map((row) => [row.key, row.label, row.receivableCents])).toEqual([
      ['private', null, 0],
      [osde.id, 'OSDE Finanzas', 1_500_000],
    ]);
    expect(body.byType).toEqual([
      expect.objectContaining({ key: 'Consulta', chargedCents: 15_800_000 }),
    ]);
  });

  it('narrows to a payer and to a location', async () => {
    const payer = await financial(world.owner, { ...MAY, tenantPayerId: osde.id });
    const norte = await financial(world.owner, { ...MAY, locationId: world.norte });

    expect(payer.body.totals.charged.totalCents).toBe(1_800_000);
    expect(payer.body.totals.receivable.cents).toBe(1_500_000);
    expect(norte.body.totals.charged.totalCents).toBe(2_000_000);
    expect(norte.body.totals.collected.netCents).toBe(2_000_000);
    expect(norte.body.totals.invoiced.netCents).toBe(0);
  });

  it('puts a period without anything at zero, not at an error', async () => {
    const { response, body } = await financial(world.owner, {
      from: '2020-01-01',
      to: '2020-01-31',
    });

    expect(response.statusCode).toBe(200);
    expect(body.totals.charged).toEqual({
      count: 0,
      totalCents: 0,
      patientCents: 0,
      payerCents: 0,
    });
    expect(body.totals.invoiced.netCents).toBe(0);
    expect(body.byPeriod).toEqual([]);
  });

  it('rejects a period that is inverted or longer than a year, and says why', async () => {
    const inverted = await world.api.get(
      `/reports/financial${query({ from: '2031-06-01', to: '2031-05-01' })}`,
      world.owner,
    );
    const tooLong = await world.api.get(
      `/reports/financial${query({ from: '2030-01-01', to: '2031-05-01' })}`,
      world.owner,
    );

    expect(inverted.statusCode).toBe(400);
    expect(inverted.json<Problem>().errors?.[0]?.i18nKey).toBe('reports.range.inverted');
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json<Problem>().errors?.[0]?.i18nKey).toBe('reports.range.too_long');
  });
});

describe('drilling down from a figure to its records', () => {
  const figures: Record<FinancialRecordKind, (body: FinancialReportResponse) => number> = {
    charged: (body) => body.totals.charged.totalCents,
    voided: (body) => body.totals.voided.totalCents,
    collected: (body) => body.totals.collected.netCents,
    outstanding: (body) => body.totals.outstanding.cents,
    receivable: (body) => body.totals.receivable.cents,
    invoiced: (body) => body.totals.invoiced.netCents,
  };

  it.each(Object.keys(figures) as FinancialRecordKind[])(
    'lists the %s records, page by page, and they sum to the figure',
    async (kind) => {
      const { body: report } = await financial(world.owner);

      const { rows, total, sumCents } = await allRecords(world.owner, kind);

      expect(rows.length).toBe(total);
      expect(total).toBeGreaterThan(0);
      expect(sumOf(rows, (row) => row.amountCents)).toBe(figures[kind](report));
      expect(sumCents).toBe(figures[kind](report));
    },
  );

  it('lists the refund as a negative entry of the collected records, with its method', async () => {
    const { rows } = await allRecords(world.owner, 'collected');

    expect(rows.filter((row) => row.amountCents < 0)).toEqual([
      expect.objectContaining({ status: 'refund', method: 'debit', amountCents: -500_000 }),
    ]);
    expect(
      rows
        .filter((row) => row.status === 'payment')
        .map((row) => row.method)
        .sort(),
    ).toEqual(['cash', 'debit', 'transfer']);
  });

  it('shows the voucher lines with the credit note negative', async () => {
    const { rows } = await allRecords(world.owner, 'invoiced');

    expect(rows.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([
      -1_600_000, -400_000, 2_000_000, 8_000_000,
    ]);
    expect(rows.every((row) => row.patientName === null)).toBe(true);
  });

  it('follows the filters: the records of one payer sum to the figure of that payer', async () => {
    const filters = { ...MAY, tenantPayerId: osde.id };
    const { body: report } = await financial(world.owner, filters);

    const receivable = await allRecords(world.owner, 'receivable', filters);

    expect(receivable.rows).toHaveLength(1);
    expect(sumOf(receivable.rows, (row) => row.amountCents)).toBe(report.totals.receivable.cents);
    expect(receivable.rows[0]).toMatchObject({
      payerName: 'OSDE Finanzas',
      chargeTotalCents: 1_800_000,
    });
  });

  it('carries identification and money only', async () => {
    const { body } = await records(world.owner, 'charged');

    for (const record of body.records) {
      expect(Object.keys(record).sort()).toEqual(
        [
          'amountCents',
          'chargeTotalCents',
          'date',
          'id',
          'locationId',
          'locationName',
          'method',
          'patientName',
          'payerName',
          'professionalId',
          'professionalName',
          'status',
          'typeName',
        ].sort(),
      );
    }
  });
});

describe('what each role is allowed to read', () => {
  it('gives the professional their own figures when they ask for the organization’s', async () => {
    const { response, body } = await financial(world.doctor);

    expect(response.statusCode, response.body).toBe(200);
    expect(body.filters.scope).toBe('professional');
    expect(body.totals.charged.totalCents).toBe(12_000_000);
    expect(body.totals.voided.totalCents).toBe(2_000_000);
    expect(body.totals.collected.netCents).toBe(7_500_000);
    expect(body.totals.outstanding.cents).toBe(4_500_000);
    expect(body.totals.receivable.cents).toBe(0);
    expect(body.totals.invoiced.netCents).toBe(8_000_000);
    expect(body.byProfessional?.map((row) => row.key)).toEqual([world.doctor.professionalId]);
  });

  it('keeps a colleague’s revenue out of the professional’s drill-down', async () => {
    const charged = await allRecords(world.doctor, 'charged');
    const collected = await allRecords(world.doctor, 'collected');

    expect(charged.rows.every((row) => row.professionalId === world.doctor.professionalId)).toBe(
      true,
    );
    expect(sumOf(charged.rows, (row) => row.amountCents)).toBe(12_000_000);
    expect(sumOf(collected.rows, (row) => row.amountCents)).toBe(7_500_000);
  });

  it('refuses a professional who asks for a colleague, a uniform 403 that leaves a trace', async () => {
    const denials = () =>
      world.inTenant((tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, 'access.denied')),
          ),
      );
    const before = (await denials()).length;

    const { response } = await financial(world.doctor, {
      ...MAY,
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode).toBe(403);
    const after = await denials();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({
      resourceType: 'report',
      metadata: { report: 'financial' },
    });
  });

  it('gives reception the money of its locations, with no revenue by professional', async () => {
    const { response, body } = await financial(world.reception);

    expect(response.statusCode, response.body).toBe(200);
    expect(body.filters.scope).toBe('locations');
    expect(body.byProfessional).toBeNull();
    expect(body.byLocation.map((row) => row.label)).toEqual(['Centro']);
    expect(body.totals.charged.totalCents).toBe(13_800_000);
    expect(body.totals.collected.netCents).toBe(7_500_000);
    expect(body.totals.receivable.cents).toBe(1_500_000);
  });

  it('denies reception a request for revenue by professional, and a location it does not work at', async () => {
    const byProfessional = await financial(world.reception, {
      ...MAY,
      professionalId: world.doctor.professionalId,
    });
    const norte = await financial(world.reception, { ...MAY, locationId: world.norte });

    expect(byProfessional.response.statusCode).toBe(403);
    expect(norte.response.statusCode).toBe(403);
    const records403 = await records(world.reception, 'charged', {
      ...MAY,
      professionalId: world.doctor.professionalId,
    });
    expect(records403.response.statusCode).toBe(403);
  });

  it('does not name the professional in the records reception reads', async () => {
    const { rows } = await allRecords(world.reception, 'charged');

    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.professionalName === null)).toBe(true);
    expect(rows.every((row) => row.locationId === world.centro)).toBe(true);
  });

  it('gives the owner and the admin the same whole organization', async () => {
    const owner = await financial(world.owner);
    const admin = await financial(world.admin);

    expect(admin.body.totals).toEqual(owner.body.totals);
    expect(owner.body.filters.scope).toBe('organization');
  });

  it('lists in the options the payers and whether the cash report is theirs', async () => {
    const owner = (
      await world.api.get('/reports/options', world.owner)
    ).json<ReportOptionsResponse>();
    const doctor = (
      await world.api.get('/reports/options', world.doctor)
    ).json<ReportOptionsResponse>();
    const reception = (
      await world.api.get('/reports/options', world.reception)
    ).json<ReportOptionsResponse>();

    expect(owner.payers.map((payer) => payer.name)).toEqual(['OSDE Finanzas']);
    expect([owner, doctor, reception].map((options) => options.canSeeCashReport)).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      [owner, doctor, reception].map((options) => options.canSeeRevenueByProfessional),
    ).toEqual([true, true, false]);
  });
});

describe('tenant isolation and audit', () => {
  it('ignores the identifier of another organization in the query', async () => {
    const other = await createTestTenant(runtime, { slug: 'financial-report-other' });
    const plain = await financial(world.owner);

    const injected = await financial(world.owner, { ...MAY, tenantId: other.id });
    const seen = await asTenant(runtime, other.id, (tx) =>
      chargeFacts(tx, { fromDate: MAY.from, toDate: MAY.to, scope: { kind: 'all' } }),
    );

    expect(injected.response.statusCode).toBe(200);
    expect(injected.body.totals).toEqual(plain.body.totals);
    expect(injected.body.totals.charged.totalCents).toBe(15_800_000);
    // The other organization has nothing of the first one: the database itself keeps them apart.
    expect(seen.total.chargedCents).toBe(0);
  });

  it('audits the records behind a figure with the filters and the count, and the report itself not', async () => {
    const reportEntries = async () =>
      world.inTenant((tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, 'report.accessed')),
          ),
      );
    const before = (await reportEntries()).length;

    await financial(world.owner);
    expect((await reportEntries()).length).toBe(before);

    await records(world.owner, 'charged', MAY, { limit: '2' });
    const after = await reportEntries();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.metadata).toMatchObject({
      report: 'financial.records',
      kind: 'charged',
      from: '2031-05-01',
      to: '2031-05-31',
      total: 4,
      rows: 2,
    });
  });
});

describe('the cash register report', () => {
  it('shows a day with a difference of 1000 ARS together with its reason', async () => {
    const { response, body } = await cash(world.owner);

    expect(response.statusCode, response.body).toBe(200);
    const centro = body.days.find((day) => day.locationName === 'Centro');
    expect(centro).toMatchObject({
      date: '2031-05-13',
      openingCents: 1_000_000,
      closedSessions: 1,
      openSessions: 0,
      differenceCents: -100_000,
    });
    expect(centro?.sessions[0]).toMatchObject({
      status: 'closed',
      differenceCents: -100_000,
      differenceReason: 'Faltante de vuelto',
    });
    expect(body.totals.daysWithDifference).toBe(1);
  });

  it('reproduces from the register the way billing shows it', async () => {
    const { body } = await cash(world.owner);
    const centro = body.days.find((day) => day.locationName === 'Centro');
    const detail = (
      await world.api.get(`/billing/cash/sessions/${centroRegister}`, world.reception)
    ).json<CashSessionDetailResponse>();

    expect(centro?.expectedCents).toBe(detail.session.expectedCents);
    expect(centro?.countedCents).toBe(detail.session.countedCents);
    expect(centro?.byMethod).toEqual(detail.session.byMethod);
    // Opening 10000 plus 60000 in cash; the debit payment is by method and not in the drawer.
    expect(centro?.expectedCents).toBe(7_000_000);
    expect(centro?.paymentsCents).toBe(8_000_000);
  });

  it('shows the register that is still open with its expected cash and no counted cash', async () => {
    const { body } = await cash(world.owner);

    const norte = body.days.find((day) => day.locationName === 'Norte');
    expect(norte).toMatchObject({
      openSessions: 1,
      closedSessions: 0,
      openingCents: 500_000,
      expectedCents: 500_000,
      countedCents: null,
      differenceCents: null,
    });
    expect(norte?.byMethod).toEqual([
      {
        method: 'transfer',
        count: 1,
        paymentsCents: 2_000_000,
        refundsCents: 0,
        netCents: 2_000_000,
      },
    ]);
  });

  it('gives reception the registers of its locations and refuses the others', async () => {
    const own = await cash(world.reception);
    const norte = await cash(world.reception, { ...MAY, locationId: world.norte });

    expect(own.response.statusCode).toBe(200);
    expect(own.body.days.map((day) => day.locationName)).toEqual(['Centro']);
    expect(own.body.filters.scope).toBe('locations');
    expect(norte.response.statusCode).toBe(403);
  });

  it('has no cash report for a professional, whatever they ask for', async () => {
    const { response } = await cash(world.doctor);

    expect(response.statusCode).toBe(403);
  });

  it('narrows to one location and says nothing for a period without registers', async () => {
    const norte = await cash(world.owner, { ...MAY, locationId: world.norte });
    const empty = await cash(world.owner, { from: '2020-01-01', to: '2020-01-31' });

    expect(norte.body.days.map((day) => day.locationName)).toEqual(['Norte']);
    expect(empty.body.days).toEqual([]);
    expect(empty.body.totals.daysWithDifference).toBe(0);
  });
});

describe('a report in an organization that is read-only', () => {
  it('still loads: reading is on the allowlist', async () => {
    const set = (status: 'active' | 'read_only') =>
      asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set(
            status === 'read_only'
              ? { status, readOnlySince: new Date() }
              : { status, readOnlySince: null },
          )
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      const report = await financial(world.owner);
      const drill = await records(world.owner, 'charged');
      const register = await cash(world.owner);

      expect(report.response.statusCode).toBe(200);
      expect(drill.response.statusCode).toBe(200);
      expect(register.response.statusCode).toBe(200);
    } finally {
      await set('active');
    }
  });

  it('declares every route of the financial and cash reports a read', () => {
    const routes = [...world.app.routeCategories.entries()].filter(([key]) =>
      /^GET \/reports\/(financial|cash)/.test(key),
    );

    expect(routes.map(([key]) => key).sort()).toEqual([
      'GET /reports/cash',
      'GET /reports/financial',
      'GET /reports/financial/records',
    ]);
    expect(routes.every(([, category]) => category === 'read')).toBe(true);
  });
});
