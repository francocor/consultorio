import type {
  CreateInvoiceRequest,
  FieldError,
  InvoiceDto,
  InvoiceType,
  RecipientTaxCondition,
  TaxCondition,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceLine,
  pointOfSale,
  type InvoiceRow,
  type PointOfSaleRow,
} from '../../../db/schema/index.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { visibleLocationIds } from '../../access/index.js';
import {
  readChargeLines,
  readChargesForInvoicing,
  type ChargeLineForInvoicing,
} from '../../billing/index.js';
import { readPatientContact } from '../../patients/index.js';
import { readInvoiceWording } from '../../scheduling/index.js';
import { breakdownFor, lineWording, planParts } from '../domain/invoice-amounts.js';

import {
  CURRENT_TENANT,
  UNIQUE_VIOLATION,
  constraintOf,
  fullName,
  hashOf,
  sqlState,
  todayIn,
  type InvoicingActor,
} from './common.js';
import { packFor } from './country-rules.js';
import { effectiveEnvironment } from './fiscal-config.js';
import { loadInvoice, scopeOf } from './invoice-view.js';
import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { AFIP_ISSUE_JOB } from './job-names.js';
import { invoicingReadiness } from './readiness.js';
import { loadOrganization, type OrganizationFacts } from './settings.js';

export interface InvoicingDeps {
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
  /** Queues the submission to AFIP. Without a queue the sweeper of the worker picks the invoice up. */
  jobs?: JobClient | undefined;
}

export interface Viewer {
  roles: readonly ('owner' | 'admin' | 'reception' | 'professional')[];
  membershipId: string;
}

export interface CreateInvoiceInput {
  request: CreateInvoiceRequest;
  actor: InvoicingActor;
  viewer: Viewer;
  tenantId: string;
}

const validation = (path: string, i18nKey: string): AppError =>
  new AppError('validation_failed', [{ path, i18nKey } satisfies FieldError]);

/**
 * The lines the request names, locked, in the order of their ids; all of them must exist. Their
 * charges are locked first (shared): a charge that is being voided makes the invoice wait and then be
 * refused, and an invoice in progress makes the void wait (JD-S4 R1-C2).
 */
export async function lockLines(
  tx: Tx,
  ids: readonly string[],
  viewer: Viewer,
): Promise<ChargeLineForInvoicing[]> {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw validation('lines', 'validation.duplicate');
  const lines = await readChargeLines(tx, unique, { lock: true, lockCharges: true });
  // A line the caller cannot see answers like one that does not exist.
  if (lines.length !== unique.length) throw new AppError('not_found');
  const locations = await visibleLocationIds(tx, viewer);
  if (locations !== 'all' && lines.some((line) => !locations.includes(line.locationId))) {
    throw new AppError('not_found');
  }
  return lines;
}

export interface Recipient {
  kind: 'patient' | 'payer';
  patientId: string | null;
  tenantPayerId: string | null;
  name: string | null;
  taxCondition: RecipientTaxCondition;
  document: { type: 'cuit' | 'dni'; number: string } | null;
}

/**
 * Who the invoice is addressed to (e-invoicing-afip, "Recipient identification"): the patient for
 * their own portion, the payer for its portion, never a mix. The invoice goes to whoever owes the
 * amount. The payer's name and CUIT come from the payer in the organization's list.
 */
export async function resolveRecipient(
  tx: Tx,
  lines: readonly ChargeLineForInvoicing[],
  input: CreateInvoiceRequest['recipient'],
): Promise<Recipient> {
  const [first] = lines;
  if (!first) throw new AppError('invoice_lines_mixed');

  if (input.kind === 'payer') {
    const payer = first.payer;
    const sameRecipient = lines.every(
      (line) => line.portion === 'payer' && line.payer !== null && line.payer.id === payer?.id,
    );
    if (!payer || !sameRecipient) throw new AppError('invoice_lines_mixed');
    if (payer.cuit === null) throw new AppError('invoice_payer_cuit_required');
    return {
      kind: 'payer',
      patientId: null,
      tenantPayerId: payer.id,
      name: payer.name,
      // A payer is a company registered for VAT unless the person says otherwise.
      taxCondition: input.taxCondition ?? 'responsable_inscripto',
      document: { type: 'cuit', number: payer.cuit },
    };
  }

  const samePatient = lines.every(
    (line) => line.portion === 'patient' && line.patientId === first.patientId,
  );
  if (!samePatient) throw new AppError('invoice_lines_mixed');
  const contact = await readPatientContact(tx, first.patientId);
  const given = input.name?.trim();
  return {
    kind: 'patient',
    patientId: first.patientId,
    tenantPayerId: null,
    name: given ? given : contact ? fullName(contact) : null,
    taxCondition: input.taxCondition ?? 'consumidor_final',
    document: input.document ?? null,
  };
}

/** The point of sale the invoice goes through: the one asked for, or the only active one. */
export async function choosePointOfSale(
  tx: Tx,
  asked: number | undefined,
): Promise<PointOfSaleRow> {
  const active = (await tx.select().from(pointOfSale)).filter((point) => point.active);
  const chosen =
    asked === undefined
      ? active.length === 1
        ? active[0]
        : undefined
      : active.find((point) => point.number === asked);
  if (!chosen) throw new AppError('invoice_point_of_sale_invalid');
  return chosen;
}

/** Looks for the invoice a key already created. A key with another request is refused. */
export async function findReplay(
  tx: Tx,
  deps: InvoicingDeps,
  key: string,
  requestHash: string,
  scopeLocations: readonly string[] | 'all',
): Promise<InvoiceDto | null> {
  const [existing] = await tx.select().from(invoice).where(eq(invoice.idempotencyKey, key));
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw new AppError('idempotency_key_reused');
  const found = await loadInvoice(tx, deps.clock, existing.id, scopeOf(scopeLocations));
  if (!found) throw new AppError('not_found');
  return found;
}

/** Descriptions of the lines of an invoice, one per charge line, from generic wording only. */
async function describeLines(
  tx: Tx,
  lines: readonly ChargeLineForInvoicing[],
): Promise<Map<string, string>> {
  const charges = await readChargesForInvoicing(tx, [
    ...new Set(lines.map((line) => line.chargeId)),
  ]);
  // The invoice description of the appointment type, or the name of the type when it has none.
  const wording = await readInvoiceWording(
    tx,
    charges.map((charge) => charge.appointmentId),
  );
  const service = new Map(
    charges.map((charge) => [
      charge.id,
      wording.get(charge.appointmentId) ?? charge.appointmentTypeName,
    ]),
  );
  return new Map(
    lines.map((line) => [
      line.id,
      lineWording({ kind: line.kind, serviceName: service.get(line.chargeId) ?? '' }),
    ]),
  );
}

export interface NewInvoiceValues {
  status: 'pending' | 'manual';
  type: InvoiceType;
  pointOfSale: number;
  environment: 'homologation' | 'production';
  simulated: boolean;
  issueDate: string;
  key: string;
  requestHash: string;
  recipient: Recipient;
  totalCents: number;
  locationIds: string[];
  previousAttemptId?: string | undefined;
  manual?: { number: number; cae: string; caeExpiresOn: string | null } | undefined;
  creditNote?: { originalId: string; reason: string } | undefined;
}

/** Inserts the invoice row; the lines come right after, in the same transaction. */
export async function insertInvoice(
  tx: Tx,
  deps: InvoicingDeps,
  input: { values: NewInvoiceValues; actor: InvoicingActor },
): Promise<InvoiceRow> {
  const { values } = input;
  const now = deps.clock();
  const split = breakdownFor(values.type, values.totalCents);
  try {
    const [row] = await tx
      .insert(invoice)
      .values({
        tenantId: CURRENT_TENANT,
        type: values.type,
        pointOfSale: values.pointOfSale,
        status: values.status,
        deliveryState: values.status === 'pending' ? 'queued' : null,
        number: values.manual?.number ?? null,
        cae: values.manual?.cae ?? null,
        caeExpiresOn: values.manual?.caeExpiresOn ?? null,
        issuedAt: values.manual ? now : null,
        issueDate: values.issueDate,
        environment: values.environment,
        simulated: values.simulated,
        idempotencyKey: values.key,
        requestHash: values.requestHash,
        recipientKind: values.recipient.kind,
        patientId: values.recipient.patientId,
        tenantPayerId: values.recipient.tenantPayerId,
        recipientName: values.recipient.name,
        recipientTaxCondition: values.recipient.taxCondition,
        recipientDocType: values.recipient.document?.type ?? null,
        recipientDocNumber: values.recipient.document?.number ?? null,
        totalCents: values.totalCents,
        netCents: split.netCents,
        vatCents: split.vatCents,
        exemptCents: split.exemptCents,
        locationIds: values.locationIds,
        creditNoteOfId: values.creditNote?.originalId ?? null,
        reason: values.creditNote?.reason ?? null,
        previousAttemptId: values.previousAttemptId ?? null,
        // The first attempt is due now: the job that was queued with it, or the sweeper, takes it.
        nextAttemptAt: values.status === 'pending' ? now : null,
        createdBy: input.actor.userId,
      })
      .returning();
    if (!row) throw new Error('invoice insert returned no row');
    return row;
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) {
      const constraint = constraintOf(error);
      if (constraint === 'invoice_previous_attempt_key') throw new AppError('invoice_not_rejected');
      if (constraint === 'invoice_number_key') throw new AppError('invoice_number_taken');
      // Two submissions with the same key met at the index: the key was used for another request.
      if (constraint === 'invoice_idempotency_key') throw new AppError('idempotency_key_reused');
    }
    throw error;
  }
}

export async function insertInvoiceLines(
  tx: Tx,
  invoiceId: string,
  rows: readonly {
    chargeLineId: string;
    chargeId: string;
    description: string;
    amountCents: number;
  }[],
): Promise<void> {
  await tx.insert(invoiceLine).values(
    rows.map((row, index) => ({
      tenantId: CURRENT_TENANT,
      invoiceId,
      chargeLineId: row.chargeLineId,
      chargeId: row.chargeId,
      position: index + 1,
      description: row.description,
      amountCents: row.amountCents,
    })),
  );
}

/** Queues the submission of a pending invoice, in the same transaction that created it. */
export async function queueIssue(
  tx: Tx,
  deps: InvoicingDeps,
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await deps.jobs?.enqueue(tx, AFIP_ISSUE_JOB, { tenantId, invoiceId });
}

/** The fiscal facts the type rules need: the tax condition of the issuer. */
async function issuerCondition(tx: Tx): Promise<TaxCondition> {
  const [profile] = await tx.select().from(fiscalProfile);
  if (!profile) throw new AppError('invoicing_not_ready');
  return profile.taxCondition as TaxCondition;
}

/** Whether invoicing can run now; if not, why (the reasons travel as field errors). */
export async function assertReady(
  tx: Tx,
  deps: InvoicingDeps,
  organization: OrganizationFacts,
): Promise<void> {
  const readiness = await invoicingReadiness(tx, deps, organization);
  if (!readiness.available) {
    throw new AppError(
      'invoicing_not_ready',
      readiness.reasons.map((reason) => ({
        path: 'readiness',
        i18nKey: `invoicing.not_ready.${reason}`,
      })),
    );
  }
}

/**
 * Creates an invoice over charge lines (e-invoicing-afip, "Issuing an invoice with CAE"; design
 * 5.5). In ONE transaction it locks the lines (in the order of their ids, so two invoices over the
 * same lines cannot deadlock), refuses what the rules refuse, inserts the invoice as pending with
 * its lines and queues the submission. The database keeps the amount invoiced of every line between
 * zero and its amount whatever happens here (migration 0444).
 */
export async function createInvoice(
  tx: Tx,
  deps: InvoicingDeps,
  input: CreateInvoiceInput,
): Promise<InvoiceDto> {
  const { request } = input;
  const lines = await lockLines(
    tx,
    request.lines.map((line) => line.chargeLineId),
    input.viewer,
  );

  const requestHash = hashOf({
    lines: [...request.lines]
      .sort((a, b) => a.chargeLineId.localeCompare(b.chargeLineId))
      .map((line) => [line.chargeLineId, line.amountCents ?? null]),
    recipient: request.recipient,
    type: request.type ?? null,
    pointOfSale: request.pointOfSale ?? null,
    previousAttemptId: request.previousAttemptId ?? null,
  });
  const locations = await visibleLocationIds(tx, input.viewer);
  const replay = await findReplay(tx, deps, request.idempotencyKey, requestHash, locations);
  if (replay) return replay;

  const organization = await loadOrganization(tx);
  await assertReady(tx, deps, organization);

  if (lines.some((line) => line.chargeStatus === 'voided')) {
    throw new AppError('invoice_charge_voided');
  }
  const recipient = await resolveRecipient(tx, lines, request.recipient);
  const plan = planParts(lines, request.lines);
  if (!plan.ok) {
    if (plan.reason === 'over_invoiced') throw new AppError('invoice_line_over_invoiced');
    throw validation('lines', 'validation.duplicate');
  }

  // The type comes from the rules of the country; a type asked for is only checked against them.
  const pack = packFor(organization.country);
  const issuer = await issuerCondition(tx);
  const typed = pack.invoiceRules.resolveInvoiceType({
    issuer,
    recipient: recipient.taxCondition,
    ...(request.type ? { requested: request.type } : {}),
  });
  if (!typed.ok) throw validation('type', typed.error.i18nKey);
  const checked = pack.invoiceRules.checkRecipient({
    type: typed.value,
    totalCents: plan.totalCents,
    recipient: {
      taxCondition: recipient.taxCondition,
      ...(recipient.name ? { name: recipient.name } : {}),
      ...(recipient.document ? { document: recipient.document } : {}),
    },
  });
  if (!checked.ok) throw validation('recipient', checked.error.i18nKey);
  const normalized: Recipient = {
    ...recipient,
    taxCondition: checked.value.taxCondition,
    name: checked.value.name ?? recipient.name,
    document: checked.value.document ?? null,
  };

  const point = await choosePointOfSale(tx, request.pointOfSale);
  const simulated = isSimulatedIssuer(
    issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo }),
  );

  if (request.previousAttemptId) {
    const [previous] = await tx
      .select({ status: invoice.status })
      .from(invoice)
      .where(eq(invoice.id, request.previousAttemptId));
    if (!previous) throw new AppError('not_found');
    if (previous.status !== 'rejected') throw new AppError('invoice_not_rejected');
  }

  const row = await insertInvoice(tx, deps, {
    actor: input.actor,
    values: {
      status: 'pending',
      type: typed.value,
      pointOfSale: point.number,
      environment: effectiveEnvironment(point.environment, simulated),
      simulated,
      issueDate: todayIn(deps.clock(), pack.defaults.timeZone),
      key: request.idempotencyKey,
      requestHash,
      recipient: normalized,
      totalCents: plan.totalCents,
      locationIds: [...new Set(lines.map((line) => line.locationId))].sort(),
      previousAttemptId: request.previousAttemptId,
    },
  });

  const descriptions = await describeLines(tx, lines);
  const byId = new Map(lines.map((line) => [line.id, line]));
  await insertInvoiceLines(
    tx,
    row.id,
    plan.parts.map((part) => {
      const line = byId.get(part.chargeLineId);
      if (!line) throw new Error('a planned part has no line');
      return {
        chargeLineId: line.id,
        chargeId: line.chargeId,
        description: descriptions.get(line.id) ?? lineWording({ kind: line.kind, serviceName: '' }),
        amountCents: part.amountCents,
      };
    }),
  );

  await audit(tx, {
    action: 'invoice.requested',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: row.id,
    ...(normalized.patientId ? { patientId: normalized.patientId } : {}),
    metadata: {
      type: typed.value,
      totalCents: plan.totalCents,
      lineCount: plan.parts.length,
      pointOfSale: point.number,
      recipientKind: normalized.kind,
    },
  });
  if (request.previousAttemptId) {
    await audit(tx, {
      action: 'invoice.retried',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'invoice',
      resourceId: row.id,
      ...(normalized.patientId ? { patientId: normalized.patientId } : {}),
      metadata: { previousAttemptId: request.previousAttemptId },
    });
  }

  await queueIssue(tx, deps, input.tenantId, row.id);
  const created = await loadInvoice(tx, deps.clock, row.id, { kind: 'all' });
  if (!created) throw new Error('the invoice just created cannot be read');
  return created;
}
