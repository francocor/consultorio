import { PAYMENT_METHODS, type PaymentMethod } from '@consultorio/contracts';
import { sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What billing tells the reports module (reports, "Financial reports" and "Cash register report"):
 * sums of charges, payments and refunds, the records that compose them, and the registers of a
 * period. The reports module asks through here and never reads these tables itself.
 *
 * Every function takes the same `MoneyCohort`: a range of calendar days read in the time zone of
 * each location, a scope (whose charges may be seen) and the narrowing filters. A payment or a
 * refund belongs to the location, the professional, the payer and the appointment type of its
 * CHARGE, so every cut reads the same. The dates differ by figure and are stated on each function:
 * a charge by the day of its service, a payment by the day it was received.
 *
 * Administrative data only: amounts, names of places, payers and the people who work there and, in
 * the record lists, the name of the patient. Never a note, a diagnosis or a document.
 */

/** Whose charges the viewer may see: all of them, or the ones at some locations or of some professionals. */
export type MoneyScope =
  | { kind: 'all' }
  | { kind: 'limited'; locationIds: readonly string[]; professionalIds: readonly string[] };

export interface MoneyCohort {
  /** First calendar day, `YYYY-MM-DD`, at the location of each charge. */
  fromDate: string;
  /** Last calendar day, both ends included. */
  toDate: string;
  scope: MoneyScope;
  locationId?: string | undefined;
  professionalId?: string | undefined;
  /** A payer of the organization (`tenant_payer.id`). */
  tenantPayerId?: string | undefined;
}

/** The key of the private patients (no payer) in a grouping by payer. */
export const PRIVATE_PAYER = 'private';

/** One group of charges. A voided charge is counted apart and is never part of `chargedCents`. */
export interface ChargeFact {
  /** The day, the id of the location, professional or payer, `private`, the name of the type, or `all`. */
  key: string;
  /** The name of the location, professional or payer. */
  label: string | null;
  /** Charges that are not voided. */
  chargeCount: number;
  chargedCents: number;
  /** The part the patient owes and the part the payer owes; they add up to `chargedCents`. */
  patientCents: number;
  payerCents: number;
  voidedCount: number;
  voidedCents: number;
  /** Charges with something left to collect from the patient, and how much. */
  outstandingCount: number;
  outstandingCents: number;
}

export interface ChargeFacts {
  total: ChargeFact;
  byDay: ChargeFact[];
  byLocation: ChargeFact[];
  byProfessional: ChargeFact[];
  byPayer: ChargeFact[];
  byType: ChargeFact[];
}

/** One group of money received and given back. */
export interface PaymentFact {
  /** The day, the id of the location, professional or payer, `private`, the name of the type, the method, or `all`. */
  key: string;
  label: string | null;
  paymentCount: number;
  paymentsCents: number;
  /** Refunds and corrections. */
  refundCount: number;
  refundsCents: number;
}

export interface PaymentFacts {
  total: PaymentFact;
  byDay: PaymentFact[];
  byLocation: PaymentFact[];
  byProfessional: PaymentFact[];
  byPayer: PaymentFact[];
  byType: PaymentFact[];
  byMethod: PaymentFact[];
}

const DAY_MS = 86_400_000;

const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** Money columns come back as text from `bigint` sums; whole cents fit a double exactly. */
function cents(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError('A report amount is whole cents.');
  return amount;
}

/**
 * The conditions that make a cohort of charges, for an instant column read at the zone of the
 * charge's location. The first two comparisons are a coarse window in UTC (a zone is at most 14
 * hours from it) that an index on the instant can use; the next two are the exact days.
 */
function windowCondition(instant: SQL, cohort: MoneyCohort): SQL {
  const coarseFrom = new Date(Date.parse(`${cohort.fromDate}T00:00:00Z`) - DAY_MS).toISOString();
  const coarseTo = new Date(Date.parse(`${cohort.toDate}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  return sql`${instant} >= ${coarseFrom}::timestamptz
    AND ${instant} < ${coarseTo}::timestamptz
    AND ${instant} >= ((${cohort.fromDate}::date)::timestamp AT TIME ZONE l.time_zone)
    AND ${instant} < ((${cohort.toDate}::date + 1)::timestamp AT TIME ZONE l.time_zone)`;
}

/** Who may be seen and what the viewer narrowed to, on the charge (`ch`). */
function chargeCondition(cohort: MoneyCohort): SQL {
  const parts: SQL[] = [];
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
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`true`;
}

// Charges ----------------------------------------------------------------------------------------

/**
 * The charges of a cohort, one row each, with what the patient and the payer owe and what the
 * patient paid net of refunds. A charge is in the cohort by the day of its SERVICE, as the clock of
 * its location says it (the same day the exports and the charge list use).
 */
function chargeRows(cohort: MoneyCohort): SQL {
  return sql`
    SELECT ch.id AS charge_id, ch.tenant_id, ch.location_id, ch.professional_id, ch.tenant_payer_id,
           ch.patient_id, ch.status,
           coalesce(ch.snapshot ->> 'appointmentTypeName', '') AS type_name,
           (ch.status = 'voided') AS voided,
           (a.starts_at AT TIME ZONE l.time_zone)::date AS day,
           coalesce(sum(cl.amount_cents) FILTER (WHERE cl.portion = 'patient'), 0) AS patient_cents,
           coalesce(sum(cl.amount_cents) FILTER (WHERE cl.portion = 'payer'), 0) AS payer_cents,
           coalesce((SELECT sum(p.amount_cents) FROM payment p
                      WHERE p.tenant_id = ch.tenant_id AND p.charge_id = ch.id), 0)
           - coalesce((SELECT sum(r.amount_cents) FROM payment_reversal r
                        WHERE r.tenant_id = ch.tenant_id AND r.charge_id = ch.id), 0) AS paid_cents
      FROM charge ch
      JOIN appointment a ON a.tenant_id = ch.tenant_id AND a.id = ch.appointment_id
      JOIN location l ON l.tenant_id = ch.tenant_id AND l.id = ch.location_id
      JOIN charge_line cl ON cl.tenant_id = ch.tenant_id AND cl.charge_id = ch.id
     WHERE ${windowCondition(sql`a.starts_at`, cohort)} AND ${chargeCondition(cohort)}
     GROUP BY ch.id, a.starts_at, l.time_zone`;
}

const CHARGE_FIGURES = sql`
  count(*) FILTER (WHERE NOT voided)::int AS charge_count,
  coalesce(sum(patient_cents + payer_cents) FILTER (WHERE NOT voided), 0)::text AS charged_cents,
  coalesce(sum(patient_cents) FILTER (WHERE NOT voided), 0)::text AS patient_cents,
  coalesce(sum(payer_cents) FILTER (WHERE NOT voided), 0)::text AS payer_cents,
  count(*) FILTER (WHERE voided)::int AS voided_count,
  coalesce(sum(patient_cents + payer_cents) FILTER (WHERE voided), 0)::text AS voided_cents,
  count(*) FILTER (WHERE NOT voided AND patient_cents > paid_cents)::int AS outstanding_count,
  coalesce(sum(greatest(0, patient_cents - paid_cents)) FILTER (WHERE NOT voided), 0)::text
    AS outstanding_cents`;

interface FactRow extends Record<string, unknown> {
  dim: string;
  key: string;
}

interface ChargeFactRow extends FactRow {
  charge_count: number;
  charged_cents: string;
  patient_cents: string;
  payer_cents: string;
  voided_count: number;
  voided_cents: string;
  outstanding_count: number;
  outstanding_cents: string;
}

function chargeFact(row: ChargeFactRow, label: string | null = null): ChargeFact {
  return {
    key: row.key,
    label,
    chargeCount: row.charge_count,
    chargedCents: cents(row.charged_cents),
    patientCents: cents(row.patient_cents),
    payerCents: cents(row.payer_cents),
    voidedCount: row.voided_count,
    voidedCents: cents(row.voided_cents),
    outstandingCount: row.outstanding_count,
    outstandingCents: cents(row.outstanding_cents),
  };
}

const EMPTY_CHARGES: ChargeFact = {
  key: 'all',
  label: null,
  chargeCount: 0,
  chargedCents: 0,
  patientCents: 0,
  payerCents: 0,
  voidedCount: 0,
  voidedCents: 0,
  outstandingCount: 0,
  outstandingCents: 0,
};

/** The names of some places, professionals and payers (of the organization), by id. */
export async function reportNames(
  tx: Tx,
  ids: {
    locations: readonly string[];
    professionals: readonly string[];
    payers: readonly string[];
  },
): Promise<{
  locations: Map<string, string>;
  professionals: Map<string, string | null>;
  payers: Map<string, string>;
}> {
  const locations = new Map<string, string>();
  const professionals = new Map<string, string | null>();
  const payers = new Map<string, string>();
  if (ids.locations.length > 0) {
    const found = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id::text, name FROM location WHERE id IN (${idList(ids.locations)})`,
    );
    for (const row of found.rows) locations.set(row.id, row.name);
  }
  if (ids.professionals.length > 0) {
    const found = await tx.execute<{ id: string; name: string | null }>(sql`
      SELECT p.id::text, m.display_name AS name
        FROM professional p
        LEFT JOIN membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
       WHERE p.id IN (${idList(ids.professionals)})`);
    for (const row of found.rows) professionals.set(row.id, row.name?.trim() || null);
  }
  if (ids.payers.length > 0) {
    const found = await tx.execute<{ id: string; name: string | null }>(sql`
      SELECT tp.id::text, coalesce(py.name, tp.custom_name) AS name
        FROM tenant_payer tp
        LEFT JOIN payer py ON py.id = tp.payer_id
       WHERE tp.id IN (${idList(ids.payers)})`);
    for (const row of found.rows) payers.set(row.id, row.name ?? '');
  }
  return { locations, professionals, payers };
}

async function withNames<T extends { key: string; label: string | null }>(
  tx: Tx,
  groups: { byLocation: T[]; byProfessional: T[]; byPayer: T[] },
): Promise<void> {
  const names = await reportNames(tx, {
    locations: groups.byLocation.map((fact) => fact.key),
    professionals: groups.byProfessional.map((fact) => fact.key),
    payers: groups.byPayer.filter((fact) => fact.key !== PRIVATE_PAYER).map((fact) => fact.key),
  });
  for (const fact of groups.byLocation) fact.label = names.locations.get(fact.key) ?? '';
  for (const fact of groups.byProfessional) fact.label = names.professionals.get(fact.key) ?? null;
  for (const fact of groups.byPayer) {
    fact.label = fact.key === PRIVATE_PAYER ? null : (names.payers.get(fact.key) ?? '');
  }
}

/**
 * The sums behind the charged, voided, outstanding and payer-receivable figures of a cohort, in one
 * pass over its charges and cut by day, location, professional, payer and appointment type.
 *
 * - Charged is the total of the lines of the charges that are not voided; voided charges are
 *   counted apart and never part of it.
 * - Outstanding is what the patient still owes on those charges: the patient's part minus what the
 *   patient paid net of refunds, never below zero per charge (the figure of the charge list).
 * - The payer's part is the receivable from the payer.
 */
export async function chargeFacts(tx: Tx, cohort: MoneyCohort): Promise<ChargeFacts> {
  const result = await tx.execute<ChargeFactRow>(sql`
    WITH c AS MATERIALIZED (${chargeRows(cohort)})
    SELECT 'day' AS dim, day::text AS key, ${CHARGE_FIGURES} FROM c GROUP BY day
    UNION ALL
    SELECT 'location', location_id::text, ${CHARGE_FIGURES} FROM c GROUP BY location_id
    UNION ALL
    SELECT 'professional', professional_id::text, ${CHARGE_FIGURES} FROM c GROUP BY professional_id
    UNION ALL
    SELECT 'payer', coalesce(tenant_payer_id::text, ${PRIVATE_PAYER}), ${CHARGE_FIGURES}
      FROM c GROUP BY tenant_payer_id
    UNION ALL
    SELECT 'type', type_name, ${CHARGE_FIGURES} FROM c GROUP BY type_name
    UNION ALL
    SELECT 'total', 'all', ${CHARGE_FIGURES} FROM c`);

  const of = (dim: string) =>
    result.rows.filter((row) => row.dim === dim).map((row) => chargeFact(row));
  const facts: ChargeFacts = {
    total: of('total')[0] ?? EMPTY_CHARGES,
    byDay: of('day').sort((a, b) => a.key.localeCompare(b.key)),
    byLocation: of('location'),
    byProfessional: of('professional'),
    byPayer: of('payer'),
    byType: of('type').sort((a, b) => a.key.localeCompare(b.key, 'es')),
  };
  await withNames(tx, facts);
  return facts;
}

// Payments ---------------------------------------------------------------------------------------

/**
 * The movements of money of a cohort: payments (+) and refunds or corrections (-), each with the
 * charge it belongs to. A movement is in the cohort by the day it happened, as the clock of the
 * charge's location says it, whatever the day of the service.
 */
function movementRows(cohort: MoneyCohort): SQL {
  return sql`
    SELECT 'payment' AS movement, p.id AS entry_id, p.charge_id, ch.tenant_id,
           (p.paid_at AT TIME ZONE l.time_zone)::date AS day, p.paid_at AS at,
           ch.location_id, ch.professional_id, ch.tenant_payer_id, ch.patient_id,
           coalesce(ch.snapshot ->> 'appointmentTypeName', '') AS type_name,
           p.method, p.amount_cents
      FROM payment p
      JOIN charge ch ON ch.tenant_id = p.tenant_id AND ch.id = p.charge_id
      JOIN location l ON l.tenant_id = ch.tenant_id AND l.id = ch.location_id
     WHERE ${windowCondition(sql`p.paid_at`, cohort)} AND ${chargeCondition(cohort)}
    UNION ALL
    SELECT r.kind, r.id, r.charge_id, ch.tenant_id,
           (r.reversed_at AT TIME ZONE l.time_zone)::date, r.reversed_at,
           ch.location_id, ch.professional_id, ch.tenant_payer_id, ch.patient_id,
           coalesce(ch.snapshot ->> 'appointmentTypeName', ''),
           orig.method, r.amount_cents
      FROM payment_reversal r
      JOIN payment orig ON orig.tenant_id = r.tenant_id AND orig.id = r.payment_id
      JOIN charge ch ON ch.tenant_id = r.tenant_id AND ch.id = r.charge_id
      JOIN location l ON l.tenant_id = ch.tenant_id AND l.id = ch.location_id
     WHERE ${windowCondition(sql`r.reversed_at`, cohort)} AND ${chargeCondition(cohort)}`;
}

const PAYMENT_FIGURES = sql`
  count(*) FILTER (WHERE movement = 'payment')::int AS payment_count,
  coalesce(sum(amount_cents) FILTER (WHERE movement = 'payment'), 0)::text AS payments_cents,
  count(*) FILTER (WHERE movement <> 'payment')::int AS refund_count,
  coalesce(sum(amount_cents) FILTER (WHERE movement <> 'payment'), 0)::text AS refunds_cents`;

interface PaymentFactRow extends FactRow {
  payment_count: number;
  payments_cents: string;
  refund_count: number;
  refunds_cents: string;
}

function paymentFact(row: PaymentFactRow): PaymentFact {
  return {
    key: row.key,
    label: null,
    paymentCount: row.payment_count,
    paymentsCents: cents(row.payments_cents),
    refundCount: row.refund_count,
    refundsCents: cents(row.refunds_cents),
  };
}

const EMPTY_PAYMENTS: PaymentFact = {
  key: 'all',
  label: null,
  paymentCount: 0,
  paymentsCents: 0,
  refundCount: 0,
  refundsCents: 0,
};

/**
 * The money received and given back in a cohort, cut like the charges and also by method. Refunds
 * and corrections are reductions: they are counted apart from the payments, in the period they
 * happened, never by editing the payment they correct.
 */
export async function paymentFacts(tx: Tx, cohort: MoneyCohort): Promise<PaymentFacts> {
  const result = await tx.execute<PaymentFactRow>(sql`
    WITH m AS MATERIALIZED (${movementRows(cohort)})
    SELECT 'day' AS dim, day::text AS key, ${PAYMENT_FIGURES} FROM m GROUP BY day
    UNION ALL
    SELECT 'location', location_id::text, ${PAYMENT_FIGURES} FROM m GROUP BY location_id
    UNION ALL
    SELECT 'professional', professional_id::text, ${PAYMENT_FIGURES} FROM m GROUP BY professional_id
    UNION ALL
    SELECT 'payer', coalesce(tenant_payer_id::text, ${PRIVATE_PAYER}), ${PAYMENT_FIGURES}
      FROM m GROUP BY tenant_payer_id
    UNION ALL
    SELECT 'type', type_name, ${PAYMENT_FIGURES} FROM m GROUP BY type_name
    UNION ALL
    SELECT 'method', method, ${PAYMENT_FIGURES} FROM m GROUP BY method
    UNION ALL
    SELECT 'total', 'all', ${PAYMENT_FIGURES} FROM m`);

  const of = (dim: string) =>
    result.rows.filter((row) => row.dim === dim).map((row) => paymentFact(row));
  const facts: PaymentFacts = {
    total: of('total')[0] ?? EMPTY_PAYMENTS,
    byDay: of('day').sort((a, b) => a.key.localeCompare(b.key)),
    byLocation: of('location'),
    byProfessional: of('professional'),
    byPayer: of('payer'),
    byType: of('type').sort((a, b) => a.key.localeCompare(b.key, 'es')),
    // In the order of the catalog, so the screen and the exports always read the same.
    byMethod: PAYMENT_METHODS.flatMap((method) =>
      of('method').filter((fact) => fact.key === method),
    ),
  };
  await withNames(tx, facts);
  return facts;
}

// Records ----------------------------------------------------------------------------------------

/** The figures that can be opened into charges. */
export type ChargeRecordKind = 'charged' | 'voided' | 'outstanding' | 'receivable';

/** One record behind a money figure. */
export interface MoneyRecord {
  /** The charge, or the payment or refund entry. */
  id: string;
  date: string;
  /** Null where the record names no patient (a line of a voucher). */
  patientName: string | null;
  locationId: string;
  locationName: string;
  professionalId: string;
  professionalName: string | null;
  /** Null for a private patient. */
  payerName: string | null;
  typeName: string | null;
  /** The state of the charge, or `payment`, `refund` or `correction`. */
  status: string;
  method: PaymentMethod | null;
  /** What it adds to the figure it was opened from; negative for a refund or a correction. */
  amountCents: number;
  /** The whole charge; null on a payment. */
  chargeTotalCents: number | null;
}

export interface MoneyRecordPage {
  /** Every record of the kind, whatever the page. */
  total: number;
  /** The sum of every record of the kind: the figure the kind was opened from. */
  sumCents: number;
  records: MoneyRecord[];
}

const RECORD_NAMES = sql`
  LEFT JOIN membership mem ON mem.tenant_id = s.tenant_id AND mem.id = pr.membership_id
  LEFT JOIN tenant_payer tp ON tp.tenant_id = s.tenant_id AND tp.id = s.tenant_payer_id
  LEFT JOIN payer py ON py.id = tp.payer_id`;

interface RecordRow extends Record<string, unknown> {
  id: string;
  day: string;
  patient_name: string;
  location_id: string;
  location_name: string;
  professional_id: string;
  professional_name: string | null;
  payer_name: string | null;
  type_name: string;
  status: string;
  method: string | null;
  amount_cents: string;
  charge_total_cents: string | null;
}

function toRecord(row: RecordRow): MoneyRecord {
  const method = PAYMENT_METHODS.find((candidate) => candidate === row.method) ?? null;
  return {
    id: row.id,
    date: row.day,
    patientName: row.patient_name,
    locationId: row.location_id,
    locationName: row.location_name,
    professionalId: row.professional_id,
    professionalName: row.professional_name?.trim() || null,
    payerName: row.payer_name,
    typeName: row.type_name,
    status: row.status,
    method,
    amountCents: cents(row.amount_cents),
    chargeTotalCents: row.charge_total_cents === null ? null : cents(row.charge_total_cents),
  };
}

/** What each kind adds up: the figure it was opened from, and the rows that belong to it. */
const KIND_AMOUNT: Record<ChargeRecordKind, { amount: SQL; where: SQL }> = {
  charged: { amount: sql`s.patient_cents + s.payer_cents`, where: sql`NOT s.voided` },
  voided: { amount: sql`s.patient_cents + s.payer_cents`, where: sql`s.voided` },
  outstanding: {
    amount: sql`greatest(0, s.patient_cents - s.paid_cents)`,
    where: sql`NOT s.voided AND s.patient_cents > s.paid_cents`,
  },
  receivable: { amount: sql`s.payer_cents`, where: sql`NOT s.voided AND s.payer_cents > 0` },
};

/**
 * The charges behind one of the figures of `chargeFacts`, oldest service first, a page at a time,
 * with the total and the sum of the whole kind: the rows add up to the figure for the same cohort.
 */
export async function chargeRecords(
  tx: Tx,
  cohort: MoneyCohort,
  input: { kind: ChargeRecordKind; limit: number; offset: number },
): Promise<MoneyRecordPage> {
  const { amount, where } = KIND_AMOUNT[input.kind];
  const base = sql`WITH s AS MATERIALIZED (${chargeRows(cohort)})`;

  const totals = await tx.execute<{ total: number; sum_cents: string }>(sql`
    ${base}
    SELECT count(*)::int AS total, coalesce(sum(${amount}), 0)::text AS sum_cents
      FROM (SELECT s.* FROM s WHERE ${where}) s`);

  const page = await tx.execute<RecordRow>(sql`
    ${base}
    SELECT s.charge_id::text AS id, s.day::text AS day,
           pa.given_names || ' ' || pa.family_name AS patient_name,
           s.location_id::text, l.name AS location_name,
           s.professional_id::text, mem.display_name AS professional_name,
           coalesce(py.name, tp.custom_name) AS payer_name,
           s.type_name, s.status, NULL::text AS method,
           (${amount})::text AS amount_cents,
           (s.patient_cents + s.payer_cents)::text AS charge_total_cents
      FROM s
      JOIN patient pa ON pa.id = s.patient_id
      JOIN location l ON l.id = s.location_id
      JOIN professional pr ON pr.id = s.professional_id
      ${RECORD_NAMES}
     WHERE ${where}
     ORDER BY s.day, s.charge_id
     LIMIT ${input.limit} OFFSET ${input.offset}`);

  return {
    total: totals.rows[0]?.total ?? 0,
    sumCents: cents(totals.rows[0]?.sum_cents ?? 0),
    records: page.rows.map(toRecord),
  };
}

/**
 * The payments and refunds behind the collected figure, oldest first, a page at a time. A refund
 * or a correction comes with a negative amount, so the rows add up to the net collected.
 */
export async function paymentRecords(
  tx: Tx,
  cohort: MoneyCohort,
  input: { limit: number; offset: number },
): Promise<MoneyRecordPage> {
  const base = sql`WITH s AS MATERIALIZED (${movementRows(cohort)})`;
  const signed = sql`(CASE WHEN s.movement = 'payment' THEN s.amount_cents ELSE -s.amount_cents END)`;

  const totals = await tx.execute<{ total: number; sum_cents: string }>(sql`
    ${base}
    SELECT count(*)::int AS total, coalesce(sum(${signed}), 0)::text AS sum_cents FROM s`);

  const page = await tx.execute<RecordRow>(sql`
    ${base}
    SELECT s.entry_id::text AS id, s.day::text AS day,
           pa.given_names || ' ' || pa.family_name AS patient_name,
           s.location_id::text, l.name AS location_name,
           s.professional_id::text, mem.display_name AS professional_name,
           coalesce(py.name, tp.custom_name) AS payer_name,
           s.type_name, s.movement AS status, s.method,
           (${signed})::text AS amount_cents, NULL::text AS charge_total_cents
      FROM s
      JOIN patient pa ON pa.id = s.patient_id
      JOIN location l ON l.id = s.location_id
      JOIN professional pr ON pr.id = s.professional_id
      ${RECORD_NAMES}
     ORDER BY s.at, s.entry_id
     LIMIT ${input.limit} OFFSET ${input.offset}`);

  return {
    total: totals.rows[0]?.total ?? 0,
    sumCents: cents(totals.rows[0]?.sum_cents ?? 0),
    records: page.rows.map(toRecord),
  };
}

// Payers -----------------------------------------------------------------------------------------

/** The payers of the organization, for the filter of the financial report (deactivated ones stay). */
export async function reportPayers(tx: Tx): Promise<{ id: string; name: string }[]> {
  const found = await tx.execute<{ id: string; name: string }>(sql`
    SELECT tp.id::text, coalesce(py.name, tp.custom_name, '') AS name
      FROM tenant_payer tp
      LEFT JOIN payer py ON py.id = tp.payer_id
     ORDER BY lower(coalesce(py.name, tp.custom_name, ''))`);
  return found.rows;
}

// Cash registers ---------------------------------------------------------------------------------

export interface CashRegisterFilter {
  /** First day, `YYYY-MM-DD`, of the day the register was OPENED, at the clock of its location. */
  fromDate: string;
  toDate: string;
  /** The locations the viewer may see, or all of them. */
  locationIds: readonly string[] | 'all';
  locationId?: string | undefined;
}

export interface CashRegisterMethod {
  method: PaymentMethod;
  paymentCount: number;
  paymentsCents: number;
  refundCount: number;
  refundsCents: number;
}

/** A register of a location, with what went through it. */
export interface CashRegisterFact {
  id: string;
  locationId: string;
  locationName: string;
  /** The day it was opened, at the clock of the location. */
  date: string;
  status: 'open' | 'closed';
  openedAt: Date;
  closedAt: Date | null;
  openingCents: number;
  /** What a closed register wrote when it closed; what an open one holds now. */
  expectedCents: number;
  countedCents: number | null;
  differenceCents: number | null;
  differenceReason: string | null;
  byMethod: CashRegisterMethod[];
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  location_name: string;
  day: string;
  status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  opening_cents: string;
  expected_cents: string | null;
  counted_cents: string | null;
  difference_cents: string | null;
  difference_reason: string | null;
}

interface MethodRow extends Record<string, unknown> {
  session_id: string;
  method: string;
  entries: number;
  cents: string;
}

/**
 * The registers opened in a period, one per row, with their payments and refunds by method. The
 * registers of closed days keep the figures they wrote when they closed; an open one shows what it
 * holds now. A register belongs to the day it was opened, however late it was closed.
 */
export async function cashRegisters(
  tx: Tx,
  filter: CashRegisterFilter,
): Promise<CashRegisterFact[]> {
  const conditions: SQL[] = [
    sql`cs.opened_at >= ${new Date(Date.parse(`${filter.fromDate}T00:00:00Z`) - DAY_MS).toISOString()}::timestamptz`,
    sql`cs.opened_at < ${new Date(Date.parse(`${filter.toDate}T00:00:00Z`) + 2 * DAY_MS).toISOString()}::timestamptz`,
    sql`(cs.opened_at AT TIME ZONE l.time_zone)::date BETWEEN ${filter.fromDate}::date AND ${filter.toDate}::date`,
  ];
  if (filter.locationIds !== 'all') {
    conditions.push(
      filter.locationIds.length > 0
        ? sql`cs.location_id IN (${idList(filter.locationIds)})`
        : sql`false`,
    );
  }
  if (filter.locationId !== undefined) {
    conditions.push(sql`cs.location_id = ${filter.locationId}::uuid`);
  }
  const sessions = sql`
    SELECT cs.id, cs.location_id, l.name AS location_name,
           (cs.opened_at AT TIME ZONE l.time_zone)::date::text AS day,
           cs.status, cs.opened_at, cs.closed_at, cs.opening_cents,
           cs.expected_cents, cs.counted_cents, cs.difference_cents, cs.difference_reason
      FROM cash_session cs
      JOIN location l ON l.tenant_id = cs.tenant_id AND l.id = cs.location_id
     WHERE ${sql.join(conditions, sql` AND `)}`;

  const found = await tx.execute<SessionRow>(
    sql`${sessions} ORDER BY day, location_name, cs.opened_at, cs.id`,
  );
  if (found.rows.length === 0) return [];

  // What went through the registers, by method: the money received and the money given back.
  const [received, returned] = await Promise.all([
    tx.execute<MethodRow>(sql`
      WITH s AS (${sessions})
      SELECT p.cash_session_id::text AS session_id, p.method, count(*)::int AS entries,
             sum(p.amount_cents)::text AS cents
        FROM payment p JOIN s ON s.id = p.cash_session_id
       GROUP BY p.cash_session_id, p.method`),
    tx.execute<MethodRow>(sql`
      WITH s AS (${sessions})
      SELECT r.cash_session_id::text AS session_id, orig.method, count(*)::int AS entries,
             sum(r.amount_cents)::text AS cents
        FROM payment_reversal r
        JOIN s ON s.id = r.cash_session_id
        JOIN payment orig ON orig.tenant_id = r.tenant_id AND orig.id = r.payment_id
       GROUP BY r.cash_session_id, orig.method`),
  ]);

  const bySession = new Map<string, Map<PaymentMethod, CashRegisterMethod>>();
  const slot = (sessionId: string, name: string): CashRegisterMethod | undefined => {
    const method = PAYMENT_METHODS.find((candidate) => candidate === name);
    if (method === undefined) return undefined;
    const methods = bySession.get(sessionId) ?? new Map<PaymentMethod, CashRegisterMethod>();
    bySession.set(sessionId, methods);
    let entry = methods.get(method);
    if (!entry) {
      entry = { method, paymentCount: 0, paymentsCents: 0, refundCount: 0, refundsCents: 0 };
      methods.set(method, entry);
    }
    return entry;
  };
  for (const row of received.rows) {
    const entry = slot(row.session_id, row.method);
    if (entry) {
      entry.paymentCount += row.entries;
      entry.paymentsCents += cents(row.cents);
    }
  }
  for (const row of returned.rows) {
    const entry = slot(row.session_id, row.method);
    if (entry) {
      entry.refundCount += row.entries;
      entry.refundsCents += cents(row.cents);
    }
  }

  return found.rows.map((row): CashRegisterFact => {
    const methods = bySession.get(row.id) ?? new Map<PaymentMethod, CashRegisterMethod>();
    const cash = methods.get('cash');
    const opening = cents(row.opening_cents);
    return {
      id: row.id,
      locationId: row.location_id,
      locationName: row.location_name,
      date: row.day,
      status: row.status,
      openedAt: new Date(row.opened_at),
      closedAt: row.closed_at === null ? null : new Date(row.closed_at),
      openingCents: opening,
      // Only cash is in the drawer: the other methods appear by method and never in what is expected.
      expectedCents:
        row.expected_cents === null
          ? opening + (cash?.paymentsCents ?? 0) - (cash?.refundsCents ?? 0)
          : cents(row.expected_cents),
      countedCents: row.counted_cents === null ? null : cents(row.counted_cents),
      differenceCents: row.difference_cents === null ? null : cents(row.difference_cents),
      differenceReason: row.difference_reason,
      // In the order of the catalog, so the screen and the exports always read the same.
      byMethod: PAYMENT_METHODS.flatMap((method) => {
        const entry = methods.get(method);
        return entry ? [entry] : [];
      }),
    };
  });
}
