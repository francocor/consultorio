import {
  ChargeSnapshotDto,
  CHARGE_LINE_KINDS,
  CHARGE_LINE_PORTIONS,
  CHARGE_REVIEW_REASONS,
  CHARGE_STATUSES,
  money,
  type ChargeDto,
  type ChargeLineDto,
} from '@consultorio/contracts';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import { charge, chargeLine, type ChargeLineRow } from '../../../db/schema/billing-charges.js';
import { tenantPayer } from '../../../db/schema/billing-pricing.js';
import { membership } from '../../../db/schema/identity.js';
import { patient } from '../../../db/schema/patients.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { invoicingPositionOf, summarizeCharge } from '../domain/charge-status.js';

import { paidNetByCharge } from './payment-totals.js';
import type { BillingScope } from './scope.js';

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in a charge`);
  return found;
}

function maybeOneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return value === null ? null : oneOf(values, value);
}

export function toLineDto(row: ChargeLineRow): ChargeLineDto {
  return {
    id: row.id,
    position: row.position,
    kind: oneOf(CHARGE_LINE_KINDS, row.kind),
    portion: oneOf(CHARGE_LINE_PORTIONS, row.portion),
    description: row.description,
    amountCents: money(row.amountCents),
    invoicedCents: money(row.invoicedCents),
  };
}

/** The condition that keeps a query to the charges a viewer may see; none for a viewer who sees all. */
export function scopeCondition(scope: BillingScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  const parts: SQL[] = [];
  if (scope.locationIds.length > 0) parts.push(inArray(charge.locationId, [...scope.locationIds]));
  if (scope.professionalId !== null) parts.push(eq(charge.professionalId, scope.professionalId));
  // Nothing in scope: a condition that is never true, never "everything".
  return or(...parts) ?? sql`false`;
}

/** The day of the service as the clock of the location says it (`date`). */
export const serviceDay = sql<string>`(${appointment.startsAt} at time zone ${location.timeZone})::date`;

const chargeColumns = {
  row: charge,
  startsAt: appointment.startsAt,
  givenNames: patient.givenNames,
  familyName: patient.familyName,
  professionalName: membership.displayName,
  locationName: location.name,
  catalogPayerName: payer.name,
  customPayerName: tenantPayer.customName,
};

function chargeQuery(tx: Tx) {
  return tx
    .select(chargeColumns)
    .from(charge)
    .innerJoin(appointment, eq(appointment.id, charge.appointmentId))
    .innerJoin(patient, eq(patient.id, charge.patientId))
    .innerJoin(professional, eq(professional.id, charge.professionalId))
    .leftJoin(membership, eq(membership.id, professional.membershipId))
    .innerJoin(location, eq(location.id, charge.locationId))
    .leftJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId));
}

type ChargeView = Awaited<ReturnType<typeof chargeQuery>>[number];

function toChargeDto(
  view: ChargeView,
  lines: readonly ChargeLineRow[],
  paidNetCents: number,
): ChargeDto {
  const { row } = view;
  const summary = summarizeCharge(lines, paidNetCents);
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    appointmentTypeName: ChargeSnapshotDto.parse(row.snapshot).appointmentTypeName,
    startsAt: view.startsAt.toISOString(),
    patientId: row.patientId,
    patientName: `${view.givenNames} ${view.familyName}`.trim(),
    professionalId: row.professionalId,
    professionalName: view.professionalName?.trim() || 'Profesional',
    locationId: row.locationId,
    locationName: view.locationName,
    tenantPayerId: row.tenantPayerId,
    payerName: row.tenantPayerId === null ? null : (view.catalogPayerName ?? view.customPayerName),
    planName: row.planName,
    status: oneOf(CHARGE_STATUSES, row.status),
    explicitAmount: row.explicitAmount,
    needsReview: row.needsReview,
    reviewReason: maybeOneOf(CHARGE_REVIEW_REASONS, row.reviewReason),
    flaggedAt: row.flaggedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    lines: lines.map(toLineDto),
    totalCents: money(summary.totalCents),
    patientCents: money(summary.patientCents),
    payerCents: money(summary.payerCents),
    paidCents: money(summary.paidCents),
    outstandingCents: money(summary.outstandingCents),
    creditCents: money(summary.creditCents),
    invoicedCents: money(summary.invoicedCents),
    invoicing: invoicingPositionOf(lines),
    snapshot: ChargeSnapshotDto.parse(row.snapshot),
    capturedBy: row.capturedBy,
    capturedAt: row.createdAt.toISOString(),
  };
}

/**
 * Charges as the screens and the invoicing module read them, newest service first: who, where, what
 * for, the lines, and the amounts derived from them and from the payments. `conditions` narrow the
 * list (and always include the scope of the viewer).
 */
export async function loadCharges(
  tx: Tx,
  conditions: readonly (SQL | undefined)[],
  options: { limit?: number } = {},
): Promise<ChargeDto[]> {
  const views = await chargeQuery(tx)
    .where(and(...conditions))
    .orderBy(desc(appointment.startsAt), desc(charge.id))
    .limit(options.limit ?? 300);
  if (views.length === 0) return [];

  const ids = views.map((view) => view.row.id);
  const [lineRows, paid] = await Promise.all([
    tx
      .select()
      .from(chargeLine)
      .where(inArray(chargeLine.chargeId, ids))
      .orderBy(asc(chargeLine.chargeId), asc(chargeLine.position)),
    paidNetByCharge(tx, ids),
  ]);
  return views.map((view) =>
    toChargeDto(
      view,
      lineRows.filter((line) => line.chargeId === view.row.id),
      paid.get(view.row.id) ?? 0,
    ),
  );
}

/** One charge, if it exists and the viewer may see it. */
export async function loadCharge(
  tx: Tx,
  chargeId: string,
  scope: BillingScope,
): Promise<ChargeDto | null> {
  const [found] = await loadCharges(tx, [eq(charge.id, chargeId), scopeCondition(scope)], {
    limit: 1,
  });
  return found ?? null;
}
