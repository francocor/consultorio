import { money, type ReceivableQuery, type ReceivablesResponse } from '@consultorio/contracts';
import { and, asc, eq, gte, lte, ne } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { tenantPayer } from '../../../db/schema/billing-pricing.js';
import { patient } from '../../../db/schema/patients.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { scopeCondition, serviceDay } from './charge-view.js';
import type { BillingScope } from './scope.js';

/**
 * What each payer owes the organization (billing-payments, "Payer portion is not a patient
 * payment"): the payer lines of the charges that are not voided, grouped by payer. A payment of the
 * patient never reduces it. The payer settlement (the process outside the system) is what clears it.
 */
export async function listReceivables(
  tx: Tx,
  input: { query: ReceivableQuery; scope: BillingScope },
): Promise<ReceivablesResponse> {
  const { query } = input;
  const rows = await tx
    .select({
      tenantPayerId: charge.tenantPayerId,
      chargeId: charge.id,
      amountCents: chargeLine.amountCents,
      startsAt: appointment.startsAt,
      typeName: charge.snapshot,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      catalogName: payer.name,
      customName: tenantPayer.customName,
    })
    .from(chargeLine)
    .innerJoin(charge, eq(charge.id, chargeLine.chargeId))
    .innerJoin(appointment, eq(appointment.id, charge.appointmentId))
    .innerJoin(location, eq(location.id, charge.locationId))
    .innerJoin(patient, eq(patient.id, charge.patientId))
    .innerJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
    .where(
      and(
        eq(chargeLine.portion, 'payer'),
        ne(charge.status, 'voided'),
        scopeCondition(input.scope),
        query.tenantPayerId ? eq(charge.tenantPayerId, query.tenantPayerId) : undefined,
        query.from ? gte(serviceDay, query.from) : undefined,
        query.to ? lte(serviceDay, query.to) : undefined,
      ),
    )
    .orderBy(asc(tenantPayer.id), asc(appointment.startsAt), asc(charge.id));

  const groups = new Map<string, ReceivablesResponse['groups'][number]>();
  let total = 0;
  for (const row of rows) {
    if (row.tenantPayerId === null) continue;
    const snapshot = row.typeName as { appointmentTypeName?: unknown } | null;
    const group = groups.get(row.tenantPayerId) ?? {
      tenantPayerId: row.tenantPayerId,
      payerName: row.catalogName ?? row.customName ?? '',
      totalCents: money(0),
      items: [],
    };
    group.items.push({
      chargeId: row.chargeId,
      patientName: `${row.givenNames} ${row.familyName}`.trim(),
      startsAt: row.startsAt.toISOString(),
      appointmentTypeName:
        typeof snapshot?.appointmentTypeName === 'string' ? snapshot.appointmentTypeName : '',
      amountCents: money(row.amountCents),
    });
    group.totalCents = money(group.totalCents + row.amountCents);
    total += row.amountCents;
    groups.set(row.tenantPayerId, group);
  }
  return { groups: [...groups.values()], totalCents: money(total) };
}
