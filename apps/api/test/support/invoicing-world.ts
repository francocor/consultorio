import type {
  ChargeDto,
  ChargeLineDto,
  CreateInvoiceRequest,
  InvoiceDto,
  TaxCondition,
} from '@consultorio/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import {
  createFakeInvoiceIssuer,
  type FakeInvoiceIssuer,
} from '../../src/adapters/afip-fake/index.js';
import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import type { JobRunResult } from '../../src/platform/jobs/define-job.js';

import { createBillingWorld, submissionKey, type BillingWorld } from './billing-world.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import type { TestSession } from './session.js';

export interface InvoicingWorld extends BillingWorld {
  /** The in-memory issuer of this world: the test sets its mode and reads its vouchers. */
  issuer: FakeInvoiceIssuer;
  /** What the application enqueued. */
  recorded: RecordingJobClient;
  storage: MemoryObjectStorage;
  email: FakeEmailSender;
  /** The lines of a charge as billing shows them. */
  linesOf(chargeId: string): Promise<ChargeLineDto[]>;
  /** The charge as billing shows it (its invoicing position included). */
  chargeOf(chargeId: string): Promise<ChargeDto>;
  /** Asks for an invoice over `body.lines`, as reception unless `by` says otherwise. */
  invoice(
    body: Omit<CreateInvoiceRequest, 'idempotencyKey'> & { idempotencyKey?: string },
    by?: TestSession,
  ): Promise<LightMyRequestResponse>;
  /** An invoice over every patient line of the charge, still not invoiced. */
  invoiceCharge(
    charge: ChargeDto,
    extra?: Partial<CreateInvoiceRequest>,
    by?: TestSession,
  ): Promise<LightMyRequestResponse>;
  /** Asks for a credit note of an invoice, as the owner unless `by` says otherwise. */
  creditNote(
    invoiceId: string,
    body?: { reason?: string; amountCents?: number; idempotencyKey?: string },
    by?: TestSession,
  ): Promise<LightMyRequestResponse>;
  getInvoice(id: string, by?: TestSession): Promise<InvoiceDto>;
  /** Runs the `afip.issue` jobs that are pending now, the way the worker would (one round). */
  runIssue(clock?: () => Date): Promise<{ name: string; result: JobRunResult }[]>;
  /** Asks for an invoice over the charge and runs the job: the invoice is issued. */
  issueInvoiceOf(charge: ChargeDto, extra?: Partial<CreateInvoiceRequest>): Promise<InvoiceDto>;
  /** Changes the tax condition of the issuer. */
  setTaxCondition(taxCondition: TaxCondition): Promise<void>;
  /** Turns e-invoicing on or off for the organization. */
  switchEinvoicing(enabled: boolean): Promise<void>;
}

/**
 * The billing world with e-invoicing configured: a fiscal profile (a monotributista unless told
 * otherwise), point of sale 1 in homologation, the organization's switch on, a price for the
 * consultation, and an in-memory AFIP issuer that belongs to this world alone (so its modes never
 * leak into another test file). One world per test file.
 */
export async function createInvoicingWorld(
  runtime: DbHandle,
  options: { slug: string; taxCondition?: TaxCondition },
): Promise<InvoicingWorld> {
  const issuer = createFakeInvoiceIssuer();
  const adapters: AdapterResolver = {
    forTenant: (_tenant, port) => (port === 'invoiceIssuer' ? issuer : undefined) as never,
  };
  const recorded = createRecordingJobClient();
  const storage = createMemoryObjectStorage();
  const email = createFakeEmailSender();
  const world = await createBillingWorld(runtime, {
    slug: options.slug,
    app: { adapters, jobs: recorded, storage, email },
  });

  const profile = async (taxCondition: TaxCondition) => {
    const response = await world.api.put('/invoicing/profile', world.owner, {
      cuit: '20-12345678-6',
      taxCondition,
      businessName: 'Consultorio Aillu',
      address: 'Av. Siempre Viva 123, CABA',
      activityStartedOn: '2020-03-01',
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  await profile(options.taxCondition ?? 'monotributo');
  const point = await world.api.post('/invoicing/points-of-sale', world.owner, { number: 1 });
  expect(point.statusCode, point.body).toBe(201);
  const switched = await world.api.patch('/settings', world.owner, {
    integrations: { einvoicing: true },
  });
  expect(switched.statusCode, switched.body).toBe(200);
  await world.setPrice(2_000_000);

  const chargeOf: InvoicingWorld['chargeOf'] = async (chargeId) => {
    const response = await world.api.get(`/billing/charges/${chargeId}`, world.owner);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ChargeDto>();
  };

  const invoice: InvoicingWorld['invoice'] = (body, by = world.reception) =>
    world.api.post('/invoices', by, { idempotencyKey: submissionKey(), ...body });

  const runIssue: InvoicingWorld['runIssue'] = (clock = () => new Date()) =>
    runPending(runtime.db, recorded, [createAfipIssueJob({ adapters, clock, jobs: recorded })]);

  const invoiceCharge: InvoicingWorld['invoiceCharge'] = async (
    charge,
    extra = {},
    by = world.reception,
  ) => {
    const fresh = await chargeOf(charge.id);
    return invoice(
      {
        lines: fresh.lines
          .filter((line) => line.portion === 'patient' && line.invoicedCents < line.amountCents)
          .map((line) => ({ chargeLineId: line.id })),
        recipient: { kind: 'patient' },
        ...extra,
      },
      by,
    );
  };

  return {
    ...world,
    issuer,
    recorded,
    storage,
    email,
    runIssue,
    issueInvoiceOf: async (charge, extra = {}) => {
      const response = await invoiceCharge(charge, extra);
      expect(response.statusCode, response.body).toBe(202);
      const created = response.json<InvoiceDto>();
      await runIssue();
      const issued = await world.api.get(`/invoices/${created.id}`, world.owner);
      expect(issued.statusCode, issued.body).toBe(200);
      return issued.json<InvoiceDto>();
    },
    chargeOf,
    linesOf: async (chargeId) => (await chargeOf(chargeId)).lines,
    invoice,
    invoiceCharge,
    creditNote: (invoiceId, body = {}, by = world.owner) =>
      world.api.post(`/invoices/${invoiceId}/credit-notes`, by, {
        idempotencyKey: submissionKey(),
        reason: 'Error en la carga del importe',
        ...body,
      }),
    getInvoice: async (id, by = world.owner) => {
      const response = await world.api.get(`/invoices/${id}`, by);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<InvoiceDto>();
    },
    setTaxCondition: profile,
    switchEinvoicing: async (enabled) => {
      const response = await world.api.patch('/settings', world.owner, {
        integrations: { einvoicing: enabled },
      });
      expect(response.statusCode, response.body).toBe(200);
    },
  };
}
