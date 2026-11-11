import type {
  ChargeDto,
  CashSessionDto,
  ExportRequestDto,
  InvoiceDto,
  Problem,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createBillingExportJob } from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { STAGE4_ROUTES, isStage4Route } from '../policy/stage4-routes.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { runPending } from '../support/jobs.js';

/**
 * Every route of Stage 4 in an organization that is read-only for non-payment (tasks 4.60; BIL-14,
 * INV-13, RPT-12, TEN-11): the table of `test/policy/stage4-routes.ts` says what each route is, and
 * this file calls each one twice, with the organization active and read-only.
 *
 * - A `write` is refused with 402 `tenant_read_only` and changes nothing.
 * - A `read` and an `export` answer exactly what they answered before: reading, exporting and the
 *   links to the PDFs of vouchers already issued keep working.
 *
 * A route that is in the table and not in the matrix below (or the other way round) fails the first
 * test, so the matrix cannot fall behind the application.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

interface Fixture {
  charge: ChargeDto;
  paymentId: string;
  sessionId: string;
  invoice: InvoiceDto;
  exportId: string;
  pointOfSaleId: string;
  payerId: string;
  priceId: string;
  payerPriceId: string;
}
let ids: Fixture;

const PERIOD = { from: '2031-01-01', to: '2031-12-31' };
/** Payments carry the day they were recorded, which is today's: the export of them looks around it. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const AROUND_TODAY = { from: day(-1), to: day(1) };
const QUERY = `from=${PERIOD.from}&to=${PERIOD.to}`;
const NO_ID = '0190a000-0000-7000-8000-0000000000aa';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'stage4-read-only' });

  const session = (await world.openRegister()) satisfies CashSessionDto;
  const charge = await world.charge();
  const paid = await world.pay(charge.id, { method: 'cash', amountCents: 500_000 });
  expect(paid.statusCode, paid.body).toBe(201);
  const invoice = await world.issueInvoiceOf(charge);
  await world.runDocuments();

  const exported = await world.api.post('/billing/exports', world.owner, {
    kind: 'payments',
    format: 'csv',
    ...AROUND_TODAY,
  });
  expect(exported.statusCode, exported.body).toBe(202);
  // The file is built, so the link to download it exists (a request still in the queue has none).
  await runPending(runtime.db, world.recorded, [
    createBillingExportJob({ storage: world.storage }),
  ]);

  const payer = await world.api.post('/billing/payers', world.owner, {
    customName: 'Prepaga de la prueba',
  });
  expect(payer.statusCode, payer.body).toBe(201);
  const payerId = payer.json<{ id: string }>().id;
  const price = await world.api.get('/billing/prices', world.owner);
  const payerPrice = await world.api.post('/billing/payer-prices', world.owner, {
    tenantPayerId: payerId,
    appointmentTypeId: world.consulta,
    payerAmountCents: 1_000_000,
    copagoCents: 100_000,
    plusCents: 0,
    effectiveFrom: '2031-02-01',
  });
  expect(payerPrice.statusCode, payerPrice.body).toBe(201);
  const config = await world.api.get('/invoicing/config', world.owner);

  ids = {
    charge: await world.chargeOf(charge.id),
    paymentId: paid.json<{ payment: { id: string } }>().payment.id,
    sessionId: session.id,
    invoice,
    exportId: exported.json<ExportRequestDto>().id,
    pointOfSaleId: config.json<{ pointsOfSale: { id: string }[] }>().pointsOfSale[0]?.id ?? '',
    payerId,
    priceId: price.json<{ prices: { id: string }[] }>().prices[0]?.id ?? NO_ID,
    payerPriceId: payerPrice.json<{ id: string }>().id,
  };
}, 120_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

type Call = () => Promise<LightMyRequestResponse>;

/**
 * One call per route of the table, as the owner (who holds every permission, so the only thing that
 * can refuse a call is the state of the organization). A write carries a body that is valid enough
 * to get past validation, because the 402 must come before the rules of the route.
 */
function matrix(): Record<string, Call> {
  const { api, owner } = world;
  const key = () => submissionKey();
  return {
    'GET /billing/payers': () => api.get('/billing/payers', owner),
    'POST /billing/payers': () =>
      api.post('/billing/payers', owner, { customName: 'Otra prepaga' }),
    'PATCH /billing/payers/:id': () =>
      api.patch(`/billing/payers/${ids.payerId}`, owner, { cuit: '30-71234567-1' }),
    'GET /billing/prices': () => api.get('/billing/prices', owner),
    'POST /billing/prices': () =>
      api.post('/billing/prices', owner, {
        appointmentTypeId: world.consulta,
        amountCents: 1,
        effectiveFrom: '2032-01-01',
      }),
    'PATCH /billing/prices/:id': () =>
      api.patch(`/billing/prices/${ids.priceId}`, owner, { active: false }),
    'GET /billing/price-quote': () =>
      api.get(`/billing/price-quote?appointmentId=${ids.charge.appointmentId}`, owner),
    'POST /billing/payer-prices': () =>
      api.post('/billing/payer-prices', owner, {
        tenantPayerId: ids.payerId,
        appointmentTypeId: world.consulta,
        payerAmountCents: 1,
        copagoCents: 0,
        plusCents: 0,
        effectiveFrom: '2032-01-01',
      }),
    'PATCH /billing/payer-prices/:id': () =>
      api.patch(`/billing/payer-prices/${ids.payerPriceId}`, owner, { active: false }),
    'POST /billing/charges': () =>
      api.post('/billing/charges', owner, { appointmentId: ids.charge.appointmentId }),
    'GET /billing/charges': () => api.get(`/billing/charges?${QUERY}`, owner),
    'GET /billing/charges/:id': () => api.get(`/billing/charges/${ids.charge.id}`, owner),
    'POST /billing/charges/:id/void': () =>
      api.post(`/billing/charges/${ids.charge.id}/void`, owner, { reason: 'Cargado por error' }),
    'POST /billing/charges/:id/lines': () =>
      api.post(`/billing/charges/${ids.charge.id}/lines`, owner, {
        description: 'Insumo',
        amountCents: 100,
      }),
    'POST /billing/charges/:id/payments': () =>
      world.pay(ids.charge.id, { method: 'debit', amountCents: 100_000 }, owner),
    'POST /billing/payments/:id/refund': () =>
      api.post(`/billing/payments/${ids.paymentId}/refund`, owner, {
        amountCents: 100,
        reason: 'Devolución',
        idempotencyKey: key(),
      }),
    'POST /billing/payments/:id/correct': () =>
      api.post(`/billing/payments/${ids.paymentId}/correct`, owner, {
        amountCents: 100,
        reason: 'Corrección',
        idempotencyKey: key(),
      }),
    'GET /billing/receivables': () => api.get('/billing/receivables', owner),
    'POST /billing/cash/sessions': () =>
      api.post('/billing/cash/sessions', owner, { locationId: world.norte, openingCents: 0 }),
    'GET /billing/cash/sessions': () => api.get(`/billing/cash/sessions?${QUERY}`, owner),
    'GET /billing/cash/current': () =>
      api.get(`/billing/cash/current?locationId=${world.centro}`, owner),
    'GET /billing/cash/sessions/:id': () =>
      api.get(`/billing/cash/sessions/${ids.sessionId}`, owner),
    'POST /billing/cash/sessions/:id/close': () =>
      api.post(`/billing/cash/sessions/${ids.sessionId}/close`, owner, { countedCents: 0 }),
    'POST /billing/exports': () =>
      api.post('/billing/exports', owner, { kind: 'charges', format: 'csv', ...PERIOD }),
    'GET /billing/exports': () => api.get('/billing/exports', owner),
    'GET /billing/exports/:id': () => api.get(`/billing/exports/${ids.exportId}`, owner),
    'POST /billing/exports/:id/download': () =>
      api.post(`/billing/exports/${ids.exportId}/download`, owner),
    'GET /invoicing/config': () => api.get('/invoicing/config', owner),
    'GET /invoicing/readiness': () => api.get('/invoicing/readiness', owner),
    'GET /invoicing/options': () => api.get('/invoicing/options', owner),
    'PUT /invoicing/profile': () =>
      api.put('/invoicing/profile', owner, {
        cuit: '20-12345678-6',
        taxCondition: 'monotributo',
        businessName: 'Consultorio Aillu',
        address: 'Av. Siempre Viva 123, CABA',
        activityStartedOn: '2020-03-01',
      }),
    'POST /invoicing/points-of-sale': () =>
      api.post('/invoicing/points-of-sale', owner, { number: 7 }),
    'PATCH /invoicing/points-of-sale/:id': () =>
      api.patch(`/invoicing/points-of-sale/${ids.pointOfSaleId}`, owner, { active: true }),
    'PUT /invoicing/credentials': () =>
      api.put('/invoicing/credentials', owner, { certificate: 'x', privateKey: 'y' }),
    'POST /invoices': () =>
      api.post('/invoices', owner, {
        idempotencyKey: key(),
        lines: [{ chargeLineId: ids.charge.lines[0]?.id ?? NO_ID }],
        recipient: { kind: 'patient' },
      }),
    'POST /invoices/manual': () =>
      api.post('/invoices/manual', owner, {
        idempotencyKey: key(),
        lines: [{ chargeLineId: ids.charge.lines[0]?.id ?? NO_ID }],
        recipient: { kind: 'patient' },
        type: 'FC',
        pointOfSale: 1,
        number: 900,
        cae: '12345678901234',
        issueDate: '2031-01-15',
        totalCents: 100,
      }),
    'GET /invoices': () => api.get('/invoices', owner),
    'GET /invoices/:id': () => api.get(`/invoices/${ids.invoice.id}`, owner),
    'GET /invoices/:id/pdf-link': () => api.get(`/invoices/${ids.invoice.id}/pdf-link`, owner),
    'POST /invoices/:id/credit-notes': () =>
      api.post(`/invoices/${ids.invoice.id}/credit-notes`, owner, {
        idempotencyKey: key(),
        reason: 'Error en la carga del importe',
      }),
    'POST /invoices/:id/void': () =>
      api.post(`/invoices/${ids.invoice.id}/void`, owner, { reason: 'Error' }),
    'GET /reports/options': () => api.get('/reports/options', owner),
    'GET /reports/operational': () => api.get(`/reports/operational?${QUERY}`, owner),
    'GET /reports/operational/records': () =>
      api.get(`/reports/operational/records?${QUERY}&group=all`, owner),
    'GET /reports/financial': () => api.get(`/reports/financial?${QUERY}`, owner),
    'GET /reports/financial/records': () =>
      api.get(`/reports/financial/records?${QUERY}&kind=charged`, owner),
    'GET /reports/cash': () => api.get(`/reports/cash?${QUERY}`, owner),
  };
}

/** Calls the route of the matrix; a route that is not in it is a mistake of this file. */
function send(calls: Record<string, Call>, route: string): Promise<LightMyRequestResponse> {
  const call = calls[route];
  if (!call) throw new Error(`The matrix has no call for ${route}.`);
  return call();
}

async function setStatus(status: 'active' | 'read_only') {
  await world.inTenant((tx) =>
    tx
      .update(tenantTable)
      .set(
        status === 'read_only'
          ? { status, readOnlySince: new Date() }
          : { status, readOnlySince: null },
      )
      .where(eq(tenantTable.id, world.tenant.id)),
  );
}

describe('the matrix covers the routes of Stage 4, and only those', () => {
  it('has a call for every route of the table, and the table for every route the application registers', () => {
    const calls = Object.keys(matrix()).sort();

    expect(calls).toEqual(Object.keys(STAGE4_ROUTES).sort());
    const registered = [...world.app.routeCategories.keys()]
      .filter((route) => isStage4Route(route) && !route.startsWith('HEAD '))
      .sort();
    expect(calls).toEqual(registered);
  });
});

describe('with the organization read-only', () => {
  it('refuses every write with 402 and the message of the account state', async () => {
    const calls = matrix();
    const writes = Object.entries(STAGE4_ROUTES)
      .filter(([, category]) => category === 'write')
      .map(([route]) => route);
    expect(writes.length).toBeGreaterThan(20);

    await setStatus('read_only');
    try {
      for (const route of writes) {
        const response = await send(calls, route);
        expect(response.statusCode, `${route}: ${response.body}`).toBe(402);
        expect(response.json<Problem>().code, route).toBe('tenant_read_only');
      }
    } finally {
      await setStatus('active');
    }
  });

  it('changes nothing while it refuses: the charge, its payments and its invoices are as they were', async () => {
    const before = await world.chargeOf(ids.charge.id);
    const invoicesBefore = (await world.api.get('/invoices', world.owner)).json<{
      invoices: unknown[];
    }>();
    const calls = matrix();

    await setStatus('read_only');
    try {
      for (const [route, category] of Object.entries(STAGE4_ROUTES)) {
        if (category === 'write') await send(calls, route);
      }
    } finally {
      await setStatus('active');
    }

    const after = await world.chargeOf(ids.charge.id);
    expect(after.payments).toEqual(before.payments);
    expect(after.lines).toEqual(before.lines);
    expect(after.status).toBe(before.status);
    const invoicesAfter = (await world.api.get('/invoices', world.owner)).json<{
      invoices: unknown[];
    }>();
    expect(invoicesAfter.invoices).toEqual(invoicesBefore.invoices);
  });

  it('answers every read and every export exactly as it did while active, with a 200 or a 202', async () => {
    const calls = matrix();
    const open = Object.entries(STAGE4_ROUTES)
      .filter(([, category]) => category !== 'write')
      .map(([route]) => route);
    expect(open.length).toBeGreaterThan(20);

    const whileActive = new Map<string, number>();
    for (const route of open) whileActive.set(route, (await send(calls, route)).statusCode);

    await setStatus('read_only');
    try {
      for (const route of open) {
        const response = await send(calls, route);
        expect(response.statusCode, `${route}: ${response.body}`).toBe(whileActive.get(route));
        expect([200, 202], route).toContain(response.statusCode);
      }
    } finally {
      await setStatus('active');
    }
  });

  it('lets the link to the PDF of an issued voucher be built, and the file be downloaded', async () => {
    await setStatus('read_only');
    try {
      const link = await world.api.get(`/invoices/${ids.invoice.id}/pdf-link`, world.owner);
      expect(link.statusCode, link.body).toBe(200);
      const file = await world.api.get(link.json<{ url: string }>().url, world.owner);

      expect(file.statusCode).toBe(200);
      expect(String(file.headers['content-type'])).toContain('application/pdf');
    } finally {
      await setStatus('active');
    }
  });
});
