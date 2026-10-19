import { eq, inArray } from 'drizzle-orm';

import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The generic wording an invoice shows for the service of some appointments (invoicing, S4.12): the
 * invoice description of the appointment type, or null when the type has none (the invoice then
 * shows the name of the type). Invoicing reads it here instead of reading the tables of scheduling.
 * The wording is administrative by design; nothing clinical is ever kept in it.
 */
export async function readInvoiceWording(
  tx: Tx,
  appointmentIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (appointmentIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: appointment.id, wording: appointmentType.invoiceDescription })
    .from(appointment)
    .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
    .where(inArray(appointment.id, [...appointmentIds]));
  return new Map(rows.map((row) => [row.id, row.wording]));
}
