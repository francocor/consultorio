import type {
  DownloadLinkResponse,
  ExportRequestDto,
  PaymentResultResponse,
  Problem,
  TenantPayerDto,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createBillingExportJob } from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from '../support/jobs.js';
import { allText, readPdf } from '../support/pdf.js';
import { asTenant } from '../support/tenants.js';

/**
 * Exports (billing-payments, "Exports"): charges, payments and the payer settlement, in three
 * formats, built by a job, downloaded through the door of the files, limited to what the person
 * may see, audited, and with an explicit empty state instead of a blank file.
 */

let runtime: DbHandle;
let world: BillingWorld;
let storage: MemoryObjectStorage;
let jobs: RecordingJobClient;
let osde: TenantPayerDto;
let swiss: TenantPayerDto;

const MAY = { from: '2031-05-01', to: '2031-05-31' };
/** Payments carry the date they were recorded, which is today's (the clock of the billing module is real). */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const AROUND_TODAY = { from: day(-1), to: day(1) };
const job = () =>
  createBillingExportJob({ storage, clock: () => new Date('2031-05-31T18:00:00.000Z') });

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  storage = createMemoryObjectStorage();
  jobs = createRecordingJobClient();
  world = await createBillingWorld(runtime, { slug: 'billing-exports', app: { storage, jobs } });
  await world.setPrice(1_000_000);

  const osdeId = await world.catalogPayer('billing-exports-osde', 'OSDE Exportable');
  const swissId = await world.catalogPayer('billing-exports-swiss', 'Swiss Exportable', 'prepaga');
  osde = (
    await world.api.post('/billing/payers', world.owner, { payerId: osdeId })
  ).json<TenantPayerDto>();
  swiss = (
    await world.api.post('/billing/payers', world.owner, { payerId: swissId })
  ).json<TenantPayerDto>();
  for (const payer of [osde, swiss]) {
    await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: payer.id,
      appointmentTypeId: world.consulta,
      payerAmountCents: payer === osde ? 1_500_000 : 1_200_000,
      copagoCents: 300_000,
      plusCents: 0,
      effectiveFrom: '2031-01-01',
    });
  }
  await world.openRegister();

  const covered = async (payerCatalogId: string, document: string, family: string) => {
    const patientId = await world.freshPatient();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute(
        sql`UPDATE patient SET national_id_type = 'dni', national_id = ${document}, family_name = ${family}
             WHERE id = ${patientId}`,
      ),
    );
    await world.cover(patientId, { payerId: payerCatalogId });
    return patientId;
  };
  const osdePatient = await covered(osdeId, '20111222', 'Ríos');
  const swissPatient = await covered(swissId, '30999888', 'Soto');

  const one = await world.charge({ patientId: osdePatient });
  const two = await world.charge({ patientId: swissPatient });
  const three = await world.charge();
  await world.pay(one.id, { method: 'cash', amountCents: 300_000, externalRef: 'EXP-001' });
  await world.pay(two.id, { method: 'debit', amountCents: 300_000 });
  const transfer = await world.pay(three.id, { method: 'transfer', amountCents: 400_000 });
  const refund = await world.api.post(
    `/billing/payments/${transfer.json<PaymentResultResponse>().payment.id}/refund`,
    world.owner,
    {
      amountCents: 100_000,
      reason: 'Devolución parcial',
      idempotencyKey: '0190a000-0000-7000-8000-00000000fff1',
    },
  );
  expect(refund.statusCode, refund.body).toBe(201);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function exportAs(
  body: Record<string, unknown>,
  by = world.owner,
): Promise<{
  request: ExportRequestDto;
  download: () => Promise<{ status: number; bytes: Buffer; headers: Record<string, unknown> }>;
}> {
  const response = await world.api.post('/billing/exports', by, { ...MAY, ...body });
  expect(response.statusCode, response.body).toBe(202);
  const created = response.json<ExportRequestDto>();
  expect(created.status).toBe('queued');
  const [result] = await runPending(runtime.db, jobs, [job()]);
  expect(result?.result.status).toBe('completed');
  const finished = (
    await world.api.get(`/billing/exports/${created.id}`, by)
  ).json<ExportRequestDto>();
  return {
    request: finished,
    download: async () => {
      const link = await world.api.post(`/billing/exports/${created.id}/download`, by);
      if (link.statusCode !== 200)
        return { status: link.statusCode, bytes: Buffer.alloc(0), headers: {} };
      const file = await world.api.get(link.json<DownloadLinkResponse>().url, by);
      return { status: file.statusCode, bytes: file.rawPayload, headers: file.headers };
    },
  };
}

async function audits() {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, 'export.requested')),
      )
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('the charges export', () => {
  it('is a CSV with a byte order mark, quoted fields and the charges of the period', async () => {
    const made = await exportAs({ kind: 'charges', format: 'csv' });
    expect(made.request).toMatchObject({
      status: 'ready',
      kind: 'charges',
      format: 'csv',
      rowCount: 3,
    });
    expect(made.request.fileName).toMatch(/^cobros-\d{8}\.csv$/);

    const file = await made.download();

    expect(file.status).toBe(200);
    expect(String(file.headers['content-type'])).toContain('text/csv');
    expect(String(file.headers['content-disposition'])).toContain(
      `filename="${made.request.fileName ?? ''}"`,
    );
    const text = file.bytes.toString('utf8');
    expect(text.startsWith('﻿"Fecha","Paciente"')).toBe(true);
    expect(text).toContain('Ríos"');
    expect(text).toContain('Soto"');
    expect(text).toContain('"Total (sin cobros anulados)"');
    // 3 charges: 18.000 + 15.000 + 10.000 in total; the patients owe 3.000 + 3.000 + 10.000.
    expect(text).toContain('"43000,00"');
    expect(text).toContain('"16000,00"');
    expect(text.split('\r\n').filter((line) => line !== '').length).toBe(5);
  });

  it('is a spreadsheet and a PDF too, with the same charges', async () => {
    const xlsx = await (await exportAs({ kind: 'charges', format: 'xlsx' })).download();
    const pdf = await (await exportAs({ kind: 'charges', format: 'pdf' })).download();

    expect(xlsx.status).toBe(200);
    expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = allText(readPdf(pdf.bytes));
    expect(text).toContain('Cobros');
    expect(text).toContain('Período 01/05/2031 al 31/05/2031');
    expect(text).toContain('Ríos');
    expect(text).toContain('$ 43.000,00');
  });
});

describe('the payments export', () => {
  it('lists payments and refunds as movements, refunds negative, with a net total', async () => {
    const made = await exportAs({ kind: 'payments', format: 'csv', ...AROUND_TODAY });

    const text = (await made.download()).bytes.toString('utf8');

    expect(made.request).toMatchObject({ status: 'ready', rowCount: 4 });
    expect(text).toContain('"Pago"');
    expect(text).toContain('"Devolución"');
    expect(text).toContain('"-1000,00"');
    expect(text).toContain('"EXP-001"');
    expect(text).toContain('"Efectivo"');
    // 3.000 + 3.000 + 4.000 - 1.000
    expect(text).toContain('"9000,00"');
  });
});

describe('an export with more rows than a file takes (JD-S4 R1-A-T7)', () => {
  it.each(['charges', 'payments', 'payer_settlement'] as const)(
    'fails the %s export with export_too_large instead of listing a truncated file with totals that look right',
    async (kind) => {
      const small = createBillingExportJob({
        storage,
        clock: () => new Date('2031-05-31T18:00:00.000Z'),
        maxRows: 1,
      });
      const response = await world.api.post('/billing/exports', world.owner, {
        ...MAY,
        ...(kind === 'payments' ? AROUND_TODAY : {}),
        kind,
        format: 'csv',
      });
      expect(response.statusCode, response.body).toBe(202);
      const created = response.json<ExportRequestDto>();

      await runPending(runtime.db, jobs, [small]);

      const finished = (
        await world.api.get(`/billing/exports/${created.id}`, world.owner)
      ).json<ExportRequestDto>();
      expect(finished).toMatchObject({
        status: 'failed',
        failureCode: 'export_too_large',
        fileName: null,
      });
    },
  );

  it('still lists everything when the rows fit', async () => {
    const made = await exportAs({ kind: 'charges', format: 'csv' });

    expect(made.request).toMatchObject({ status: 'ready', rowCount: 3 });
  });
});

describe('the day a movement is printed on (JD-S4 R1-A-W5)', () => {
  it('is the local day of the location, the same one the period is filtered by', async () => {
    const charge = await world.charge();
    // 23:30 of May 9th in Buenos Aires is already May 10th in UTC.
    await asTenant(runtime, world.tenant.id, async (tx) => {
      await tx.execute(
        sql`INSERT INTO payment (tenant_id, charge_id, location_id, method, amount_cents, paid_at,
                                 recorded_by, idempotency_key, request_hash)
              VALUES (${world.tenant.id}, ${charge.id}, ${world.centro}, 'debit', 123400,
                      '2031-05-10T02:30:00Z', ${world.owner.user.id}, '0190a000-0000-7000-8000-0000000000e1', 'late')`,
      );
    });

    const made = await exportAs({
      kind: 'payments',
      format: 'csv',
      from: '2031-05-09',
      to: '2031-05-09',
    });
    const text = (await made.download()).bytes.toString('utf8');

    expect(made.request).toMatchObject({ status: 'ready', rowCount: 1 });
    expect(text).toContain('"1234,00"');
    expect(text).toMatch(/09.05.2031|2031-05-09/);
    expect(text).not.toMatch(/10.05.2031|2031-05-10/);
  });
});

describe('the payer settlement', () => {
  it('groups the payer portions by payer with the DNI of the patient, the date, the service and the amount', async () => {
    const made = await exportAs({ kind: 'payer_settlement', format: 'csv' });

    const text = (await made.download()).bytes.toString('utf8');

    expect(made.request.fileName).toMatch(/^liquidacion-obras-sociales-\d{8}\.csv$/);
    expect(text).toContain('"OSDE Exportable"');
    expect(text).toContain('"DNI 20111222"');
    expect(text).toContain('"Swiss Exportable"');
    expect(text).toContain('"DNI 30999888"');
    expect(text).toContain('"15000,00"');
    expect(text).toContain('"12000,00"');
    expect(text).toContain('"Subtotal OSDE Exportable"');
    expect(text).toContain('"Total a liquidar"');
    expect(text).toContain('"27000,00"');
    // The patient who pays privately has no payer portion and is not in it.
    expect(made.request.rowCount).toBe(2);
  });

  it('lists only the payer asked for (OSDE alone) and nothing of another', async () => {
    const made = await exportAs({
      kind: 'payer_settlement',
      format: 'csv',
      tenantPayerId: osde.id,
    });

    const text = (await made.download()).bytes.toString('utf8');

    expect(made.request.rowCount).toBe(1);
    expect(text).toContain('"OSDE Exportable"');
    expect(text).not.toContain('Swiss');
    expect(text).not.toContain('30999888');
    expect(text).toContain('"15000,00"');
  });
});

describe('what an export may contain', () => {
  it('has only the administrative columns of its whitelist, in every kind', async () => {
    const headers = async (kind: string) => {
      const period = kind === 'payments' ? AROUND_TODAY : {};
      const made = await exportAs({ kind, format: 'csv', ...period });
      const first = (await made.download()).bytes.toString('utf8').split('\r\n')[0] ?? '';
      return first
        .replace('﻿', '')
        .split(',')
        .map((cell) => cell.replaceAll('"', ''));
    };

    const charges = await headers('charges');
    const payments = await headers('payments');
    const settlement = await headers('payer_settlement');

    expect(charges).toEqual([
      'Fecha',
      'Paciente',
      'Sede',
      'Profesional',
      'Servicio',
      'Obra social o prepaga',
      'Plan',
      'Estado',
      'Total',
      'Paciente debe',
      'Obra social debe',
      'Cobrado',
      'Falta cobrar',
    ]);
    expect(payments).toEqual([
      'Fecha',
      'Paciente',
      'Sede',
      'Servicio',
      'Obra social o prepaga',
      'Movimiento',
      'Medio',
      'Referencia',
      'Importe',
    ]);
    expect(settlement).toEqual([
      'Obra social o prepaga',
      'Plan',
      'Documento',
      'Paciente',
      'Fecha',
      'Servicio',
      'Importe',
    ]);
    for (const label of [...charges, ...payments, ...settlement]) {
      expect(label).not.toMatch(
        /nota|diagn[oó]stic|receta|prescrip|anamnes|s[ií]ntoma|tratamiento/i,
      );
    }
  });
});

describe('an empty period', () => {
  it('shows an explicit empty state, makes no file and offers no download', async () => {
    const before = storage.keys().length;

    const made = await exportAs({
      kind: 'charges',
      format: 'csv',
      from: '2040-01-01',
      to: '2040-01-31',
    });
    const link = await world.api.post(`/billing/exports/${made.request.id}/download`, world.owner);

    expect(made.request).toMatchObject({
      status: 'empty',
      rowCount: 0,
      fileName: null,
      sizeBytes: null,
    });
    expect(storage.keys().length).toBe(before);
    expect(link.statusCode).toBe(409);
  });
});

describe('who gets what, and how', () => {
  it('limits a professional to the charges of their own appointments', async () => {
    const colleaguePatient = await world.freshPatient();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute(sql`UPDATE patient SET family_name = 'Delacolega' WHERE id = ${colleaguePatient}`),
    );
    const other = await world.appointment({
      professional: world.colleague,
      patientId: colleaguePatient,
    });
    const captured = await world.api.post('/billing/charges', world.reception, {
      appointmentId: other.id,
    });
    expect(captured.statusCode, captured.body).toBe(201);

    const mine = await exportAs({ kind: 'charges', format: 'csv' }, world.doctor);
    const everyone = await exportAs({ kind: 'charges', format: 'csv' }, world.owner);
    const mineText = (await mine.download()).bytes.toString('utf8');
    const allText = (await everyone.download()).bytes.toString('utf8');

    expect(mine.request.status).toBe('ready');
    expect(mineText).toContain('Ríos"');
    expect(mineText).not.toContain('Delacolega');
    expect(allText).toContain('Delacolega');
  });

  it('binds the link to the session, once, and keeps another person from reading the request', async () => {
    const made = await exportAs({ kind: 'charges', format: 'csv' });
    const link = (
      await world.api.post(`/billing/exports/${made.request.id}/download`, world.owner)
    ).json<DownloadLinkResponse>();

    const otherSession = await world.api.get(link.url, world.admin);
    const first = await world.api.get(link.url, world.owner);
    const second = await world.api.get(link.url, world.owner);
    const theirs = await world.api.get(`/billing/exports/${made.request.id}`, world.admin);
    const theirLink = await world.api.post(
      `/billing/exports/${made.request.id}/download`,
      world.admin,
    );

    expect(otherSession.statusCode).toBe(403);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(403);
    expect(theirs.statusCode).toBe(404);
    expect(theirLink.statusCode).toBe(404);
  });

  it('audits every request with who, the filters and the moment', async () => {
    const before = (await audits()).length;

    const made = await exportAs({ kind: 'payments', format: 'xlsx', locationId: world.centro });

    const rows = await audits();
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: world.owner.user.id,
      resourceType: 'export',
      resourceId: made.request.id,
      metadata: {
        kind: 'payments',
        format: 'xlsx',
        from: '2031-05-01',
        to: '2031-05-31',
        locationId: world.centro,
      },
    });
    expect(rows[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it('refuses an unknown kind, a reversed period, a scope sent by the client, and a session without payments access', async () => {
    const bodies = [
      { kind: 'clinical', format: 'csv' },
      { kind: 'charges', format: 'csv', from: '2031-06-01', to: '2031-05-01' },
      { kind: 'charges', format: 'csv', scope: { kind: 'all' } },
    ];
    for (const body of bodies) {
      const response = await world.api.post('/billing/exports', world.reception, {
        ...MAY,
        ...body,
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await world.api.post('/billing/exports', null, { ...MAY, kind: 'charges', format: 'csv' }))
        .statusCode,
    ).toBe(401);
  });

  it('keeps working while the organization is read-only: the export is asked for and built', async () => {
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date('2031-05-20T00:00:00.000Z') })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      const made = await exportAs({ kind: 'charges', format: 'csv' });
      const payment = await world.api.post(
        `/billing/charges/0190a000-0000-7000-8000-0000000000aa/payments`,
        world.reception,
        {
          method: 'debit',
          amountCents: 100,
          idempotencyKey: '0190a000-0000-7000-8000-00000000ff02',
        },
      );

      expect(made.request.status).toBe('ready');
      expect((await made.download()).status).toBe(200);
      expect(payment.statusCode).toBe(402);
      expect(payment.json<Problem>().code).toBe('tenant_read_only');
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

describe('the job', () => {
  it('does nothing for a request that is not queued, so a redelivery builds no second file', async () => {
    const made = await exportAs({ kind: 'charges', format: 'csv' });
    const objects = storage.keys().length;

    // The same request queued again, as a redelivery under another job id would.
    await asTenant(runtime, world.tenant.id, (tx) =>
      jobs.enqueue(tx, 'export.build', { tenantId: world.tenant.id, exportId: made.request.id }),
    );
    const [rerun] = await runPending(runtime.db, jobs, [job()]);

    expect(rerun?.result.status).toBe('completed');
    expect(storage.keys().length).toBe(objects);
    const after = (
      await world.api.get(`/billing/exports/${made.request.id}`, world.owner)
    ).json<ExportRequestDto>();
    expect(after.fileName).toBe(made.request.fileName);
  });
});
