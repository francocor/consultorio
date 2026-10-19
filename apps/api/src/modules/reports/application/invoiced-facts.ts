import { CREDIT_NOTE_TYPES } from '@consultorio/contracts';
import { sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { reportNames, type MoneyCohort } from '../../billing/index.js';
import type { InvoicedGroup } from '../../invoicing/index.js';
import { PRIVATE_KEY } from '../domain/financial-rows.js';

/**
 * What the financial report adds up of the vouchers, worked out by the database in one pass.
 *
 * `readInvoicedLines` (the index of invoicing) gives the same lines one by one and asks billing for
 * the facts of each charge in chunks; for a year of vouchers that is tens of queries and about two
 * seconds, far from the 1 s target (docs/perf/reports.md). The vouchers are therefore added up here
 * with the same rules and ONE query: only `issued` and `manual` vouchers count (a pending invoice
 * is not a voucher yet and a rejected attempt never was one), by the date printed on the voucher, a
 * credit note is negative, and a line goes to the location, professional and payer of the charge it
 * covers. An integration test holds this file to `readInvoicedLines` and `summarizeInvoiced`: if
 * invoicing changes a rule, that test fails here.
 */

const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const CREDIT_NOTES = sql.join(
  CREDIT_NOTE_TYPES.map((type) => sql`${type}`),
  sql`, `,
);

/** The vouchers of a cohort, one row per line: the period by their own date, the viewer's scope on the charge. */
function voucherLines(cohort: MoneyCohort): SQL {
  const parts: SQL[] = [
    sql`i.status IN ('issued', 'manual')`,
    sql`i.issue_date >= ${cohort.fromDate}::date`,
    sql`i.issue_date <= ${cohort.toDate}::date`,
  ];
  if (cohort.scope.kind === 'limited') {
    const either = [
      ...(cohort.scope.locationIds.length > 0
        ? [sql`ch.location_id IN (${idList(cohort.scope.locationIds)})`]
        : []),
      ...(cohort.scope.professionalIds.length > 0
        ? [sql`ch.professional_id IN (${idList(cohort.scope.professionalIds)})`]
        : []),
    ];
    parts.push(either.length > 0 ? sql`(${sql.join(either, sql` OR `)})` : sql`false`);
  }
  if (cohort.locationId !== undefined) parts.push(sql`ch.location_id = ${cohort.locationId}::uuid`);
  if (cohort.professionalId !== undefined) {
    parts.push(sql`ch.professional_id = ${cohort.professionalId}::uuid`);
  }
  if (cohort.tenantPayerId !== undefined) {
    parts.push(sql`ch.tenant_payer_id = ${cohort.tenantPayerId}::uuid`);
  }
  return sql`
    SELECT i.id AS invoice_id, il.id AS line_id, i.type, i.issue_date, il.charge_line_id,
           ch.location_id, ch.professional_id, ch.tenant_payer_id,
           CASE WHEN i.type IN (${CREDIT_NOTES}) THEN -il.amount_cents ELSE il.amount_cents END
             AS net_cents
      FROM invoice_line il
      JOIN invoice i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
      JOIN charge ch ON ch.tenant_id = il.tenant_id AND ch.id = il.charge_id
     WHERE ${sql.join(parts, sql` AND `)}`;
}

const FIGURES = sql`
  coalesce(sum(net_cents) FILTER (WHERE net_cents >= 0), 0)::text AS invoiced_cents,
  coalesce(-sum(net_cents) FILTER (WHERE net_cents < 0), 0)::text AS credited_cents,
  coalesce(sum(net_cents), 0)::text AS net_cents_sum,
  count(DISTINCT invoice_id)::int AS documents`;

interface GroupRow extends Record<string, unknown> {
  dim: string;
  key: string;
  invoiced_cents: string;
  credited_cents: string;
  net_cents_sum: string;
  documents: number;
}

export interface InvoicedFacts {
  total: InvoicedGroup;
  byDay: InvoicedGroup[];
  byLocation: InvoicedGroup[];
  byProfessional: InvoicedGroup[];
  byPayer: InvoicedGroup[];
}

function groupOf(row: GroupRow): InvoicedGroup {
  return {
    key: row.key,
    invoicedCents: Number(row.invoiced_cents),
    creditedCents: Number(row.credited_cents),
    netCents: Number(row.net_cents_sum),
    documents: row.documents,
  };
}

const NOTHING: InvoicedGroup = {
  key: 'all',
  invoicedCents: 0,
  creditedCents: 0,
  netCents: 0,
  documents: 0,
};

/** More working memory for the statements of a report, for the length of their transaction (see billing). */
async function reportMemory(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL work_mem = '32MB'`);
}

/** The vouchers of a cohort added up by day, location, professional and payer, and in total. */
export async function invoicedFacts(tx: Tx, cohort: MoneyCohort): Promise<InvoicedFacts> {
  await reportMemory(tx);
  const result = await tx.execute<GroupRow>(sql`
    WITH v AS MATERIALIZED (${voucherLines(cohort)})
    SELECT 'day' AS dim, issue_date::text AS key, ${FIGURES} FROM v GROUP BY issue_date
    UNION ALL
    SELECT 'location', location_id::text, ${FIGURES} FROM v GROUP BY location_id
    UNION ALL
    SELECT 'professional', professional_id::text, ${FIGURES} FROM v GROUP BY professional_id
    UNION ALL
    SELECT 'payer', coalesce(tenant_payer_id::text, ${PRIVATE_KEY}), ${FIGURES}
      FROM v GROUP BY tenant_payer_id
    UNION ALL
    SELECT 'total', 'all', ${FIGURES} FROM v`);

  const of = (dim: string) =>
    result.rows
      .filter((row) => row.dim === dim)
      .map(groupOf)
      .sort((a, b) => a.key.localeCompare(b.key));
  const byPayer = of('payer');
  const names = await reportNames(tx, {
    locations: [],
    professionals: [],
    payers: byPayer.filter((group) => group.key !== PRIVATE_KEY).map((group) => group.key),
  });
  for (const group of byPayer) {
    if (group.key !== PRIVATE_KEY) group.label = names.payers.get(group.key) ?? '';
  }
  return {
    total: of('total')[0] ?? NOTHING,
    byDay: of('day'),
    byLocation: of('location'),
    byProfessional: of('professional'),
    byPayer,
  };
}

/** One line of a voucher, as the drill-down lists it. */
export interface VoucherLine {
  invoiceId: string;
  /** The line of the voucher (`invoice_line.id`): unique, unlike the voucher. */
  lineId: string;
  type: string;
  issueDate: string;
  locationId: string;
  professionalId: string;
  payerName: string | null;
  netCents: number;
}

interface LineRow extends Record<string, unknown> {
  invoice_id: string;
  line_id: string;
  type: string;
  issue_date: string;
  location_id: string;
  professional_id: string;
  payer_name: string | null;
  net_cents: string;
}

/**
 * The lines of the vouchers of a cohort, oldest first, a page at a time, with the number of lines
 * and their sum: the lines add up to the net invoiced of the same cohort.
 */
export async function voucherLinesPage(
  tx: Tx,
  cohort: MoneyCohort,
  page: { limit: number; offset: number },
): Promise<{ total: number; sumCents: number; lines: VoucherLine[] }> {
  await reportMemory(tx);
  const totals = await tx.execute<{ total: number; sum_cents: string }>(sql`
    WITH v AS MATERIALIZED (${voucherLines(cohort)})
    SELECT count(*)::int AS total, coalesce(sum(net_cents), 0)::text AS sum_cents FROM v`);
  const found = await tx.execute<LineRow>(sql`
    WITH v AS MATERIALIZED (${voucherLines(cohort)})
    SELECT v.invoice_id::text, v.line_id::text, v.type, v.issue_date::text, v.location_id::text,
           v.professional_id::text, coalesce(py.name, tp.custom_name) AS payer_name,
           v.net_cents::text
      FROM v
      LEFT JOIN tenant_payer tp ON tp.id = v.tenant_payer_id
      LEFT JOIN payer py ON py.id = tp.payer_id
     ORDER BY v.issue_date, v.invoice_id, v.charge_line_id, v.line_id
     LIMIT ${page.limit} OFFSET ${page.offset}`);
  return {
    total: totals.rows[0]?.total ?? 0,
    sumCents: Number(totals.rows[0]?.sum_cents ?? 0),
    lines: found.rows.map((row) => ({
      invoiceId: row.invoice_id,
      lineId: row.line_id,
      type: row.type,
      issueDate: row.issue_date,
      locationId: row.location_id,
      professionalId: row.professional_id,
      payerName: row.payer_name,
      netCents: Number(row.net_cents),
    })),
  };
}
