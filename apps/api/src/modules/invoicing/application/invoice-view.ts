import {
  FISCAL_ENVIRONMENTS,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  RECIPIENT_DOCUMENT_TYPES,
  RECIPIENT_TAX_CONDITIONS,
  invoiceKindOf,
  type InvoiceDto,
} from '@consultorio/contracts';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import {
  invoice,
  invoiceDocument,
  invoiceLine,
  type InvoiceLineRow,
  type InvoiceRow,
} from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { ageInMinutes, isOutageFlagged } from '../domain/retry-schedule.js';
import { blockerOf, heldCount } from '../domain/series-hold.js';

import { loadOrganization } from './settings.js';

/**
 * What a person may see of the invoices: all of them, or the ones that cover a charge of one of
 * their locations (reception). Decided on the server for every read.
 */
export type InvoiceScope = { kind: 'all' } | { kind: 'limited'; locationIds: readonly string[] };

export function scopeOf(locations: readonly string[] | 'all'): InvoiceScope {
  return locations === 'all' ? { kind: 'all' } : { kind: 'limited', locationIds: locations };
}

/** The rows a scope lets through, as a condition on `invoice.location_ids` (an overlap). */
export function scopeCondition(scope: InvoiceScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.locationIds.length === 0) return sql`false`;
  const ids = sql.join(
    scope.locationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`${invoice.locationIds} && ARRAY[${ids}]::uuid[]`;
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in an invoice`);
  return found;
}

export interface ViewFacts {
  now: Date;
  thresholdHours: number;
  /** The cents that the credit notes of each invoice take back (pending and issued ones). */
  credited: ReadonlyMap<string, number>;
  withPdf: ReadonlySet<string>;
  /** For a pending invoice: who holds it back, and how many it holds back itself. */
  holds: ReadonlyMap<string, SeriesHold>;
}

export interface SeriesHold {
  heldBy: { id: string; requestedAt: string } | null;
  blocksSeries: number;
}

const NO_HOLD: SeriesHold = { heldBy: null, blocksSeries: 0 };

export function toInvoiceDto(
  row: InvoiceRow,
  lines: readonly InvoiceLineRow[],
  facts: ViewFacts,
): InvoiceDto {
  const type = oneOf(INVOICE_TYPES, row.type);
  const status = oneOf(INVOICE_STATUSES, row.status);
  const pending = status === 'pending';
  const age = pending ? ageInMinutes(row.createdAt, facts.now) : null;
  const environment = oneOf(FISCAL_ENVIRONMENTS, row.environment);
  return {
    id: row.id,
    kind: invoiceKindOf(type),
    type,
    status,
    pointOfSale: row.pointOfSale,
    number: row.number,
    cae: row.cae,
    caeExpiresOn: row.caeExpiresOn,
    issueDate: row.issueDate,
    environment,
    simulated: row.simulated,
    testDocument: environment === 'homologation' || row.simulated,
    recipient: {
      kind: row.recipientKind === 'payer' ? 'payer' : 'patient',
      patientId: row.patientId,
      tenantPayerId: row.tenantPayerId,
      name: row.recipientName,
      taxCondition: oneOf(RECIPIENT_TAX_CONDITIONS, row.recipientTaxCondition),
      document:
        row.recipientDocType !== null && row.recipientDocNumber !== null
          ? {
              type: oneOf(RECIPIENT_DOCUMENT_TYPES, row.recipientDocType),
              number: row.recipientDocNumber,
            }
          : null,
    },
    totalCents: row.totalCents,
    netCents: row.netCents,
    vatCents: row.vatCents,
    exemptCents: row.exemptCents,
    creditNoteOfId: row.creditNoteOfId,
    reason: row.reason,
    previousAttemptId: row.previousAttemptId,
    rejectionMessage: row.rejectionMessage,
    creditedCents: facts.credited.get(row.id) ?? 0,
    ageMinutes: age,
    outageFlag: age !== null && isOutageFlagged(status, age, facts.thresholdHours),
    heldBy: (facts.holds.get(row.id) ?? NO_HOLD).heldBy,
    blocksSeries: (facts.holds.get(row.id) ?? NO_HOLD).blocksSeries,
    hasPdf: facts.withPdf.has(row.id),
    createdAt: row.createdAt.toISOString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    lines: lines
      .filter((line) => line.invoiceId === row.id)
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        id: line.id,
        chargeLineId: line.chargeLineId,
        chargeId: line.chargeId,
        description: line.description,
        amountCents: line.amountCents,
      })),
  };
}

export interface LoadedInvoices {
  invoices: InvoiceDto[];
  thresholdHours: number;
}

export interface LoadOptions {
  limit?: number;
  /** Pending invoices are read oldest first (the one that waited longest is the one to look at). */
  order?: 'newest' | 'oldest';
  /**
   * What the reader may see. The invoice that holds another one back is named only when it is inside
   * the scope; without a scope it is never named.
   */
  scope?: InvoiceScope;
}

/**
 * For the pending invoices among `rows`: who holds each one back and how many each one holds back.
 * The series of an invoice is its point of sale and voucher type; an invoice that waits for a person
 * (`needs_attention`) is neither held nor holding.
 */
async function seriesHolds(
  tx: Tx,
  rows: readonly InvoiceRow[],
  scope: InvoiceScope | undefined,
): Promise<Map<string, SeriesHold>> {
  const holds = new Map<string, SeriesHold>();
  const open = rows.filter(
    (row) => row.status === 'pending' && row.deliveryState !== 'needs_attention',
  );
  if (open.length === 0) return holds;
  const pairs = [
    ...new Map(open.map((row) => [`${String(row.pointOfSale)}|${row.type}`, row])).values(),
  ];
  const members = await tx
    .select({
      id: invoice.id,
      pointOfSale: invoice.pointOfSale,
      type: invoice.type,
      deliveryState: invoice.deliveryState,
      createdAt: invoice.createdAt,
      locationIds: invoice.locationIds,
    })
    .from(invoice)
    .where(
      and(
        eq(invoice.status, 'pending'),
        sql`${invoice.deliveryState} <> 'needs_attention'`,
        or(
          ...pairs.map((row) =>
            and(eq(invoice.pointOfSale, row.pointOfSale), eq(invoice.type, row.type)),
          ),
        ),
      ),
    );
  const visible = (locations: readonly string[]) =>
    scope !== undefined &&
    (scope.kind === 'all' || locations.some((id) => scope.locationIds.includes(id)));
  for (const row of open) {
    const series = members
      .filter((member) => member.pointOfSale === row.pointOfSale && member.type === row.type)
      .map((member) => ({
        id: member.id,
        awaiting: member.deliveryState === 'awaiting_reconciliation',
      }));
    const blocker = blockerOf(
      { id: row.id, awaiting: row.deliveryState === 'awaiting_reconciliation' },
      series,
    );
    const named = blocker ? members.find((member) => member.id === blocker.id) : undefined;
    holds.set(row.id, {
      heldBy:
        named && visible(named.locationIds)
          ? { id: named.id, requestedAt: named.createdAt.toISOString() }
          : null,
      blocksSeries: row.deliveryState === 'awaiting_reconciliation' ? heldCount(row.id, series) : 0,
    });
  }
  return holds;
}

/** Loads invoices with their lines, what their credit notes took and whether they have a PDF. */
export async function loadInvoices(
  tx: Tx,
  clock: () => Date,
  conditions: readonly (SQL | undefined)[],
  options: LoadOptions = {},
): Promise<LoadedInvoices> {
  const organization = await loadOrganization(tx);
  const where = and(...conditions);
  const order =
    options.order === 'oldest'
      ? [asc(invoice.createdAt), asc(invoice.id)]
      : [desc(invoice.createdAt), desc(invoice.id)];
  const rows = await tx
    .select()
    .from(invoice)
    .where(where)
    .orderBy(...order)
    .limit(options.limit ?? 100);
  if (rows.length === 0) {
    return { invoices: [], thresholdHours: organization.outageThresholdHours };
  }

  const ids = rows.map((row) => row.id);
  const lines = await tx.select().from(invoiceLine).where(inArray(invoiceLine.invoiceId, ids));
  const notes = await tx
    .select({
      original: invoice.creditNoteOfId,
      total: sql<string>`coalesce(sum(${invoice.totalCents}), 0)`,
    })
    .from(invoice)
    .where(and(inArray(invoice.creditNoteOfId, ids), sql`${invoice.status} <> 'rejected'`))
    .groupBy(invoice.creditNoteOfId);
  const documents = await tx
    .select({ invoiceId: invoiceDocument.invoiceId })
    .from(invoiceDocument)
    .where(inArray(invoiceDocument.invoiceId, ids));

  const facts: ViewFacts = {
    now: clock(),
    thresholdHours: organization.outageThresholdHours,
    credited: new Map(
      notes.flatMap((note) =>
        note.original === null ? [] : [[note.original, Number(note.total)]],
      ),
    ),
    withPdf: new Set(documents.map((document) => document.invoiceId)),
    holds: await seriesHolds(tx, rows, options.scope),
  };
  return {
    invoices: rows.map((row) => toInvoiceDto(row, lines, facts)),
    thresholdHours: organization.outageThresholdHours,
  };
}

/** One invoice, or null when there is none in the scope (a stranger's answers like a missing one). */
export async function loadInvoice(
  tx: Tx,
  clock: () => Date,
  id: string,
  scope: InvoiceScope,
): Promise<InvoiceDto | null> {
  const { invoices } = await loadInvoices(tx, clock, [eq(invoice.id, id), scopeCondition(scope)], {
    limit: 1,
    scope,
  });
  return invoices[0] ?? null;
}
