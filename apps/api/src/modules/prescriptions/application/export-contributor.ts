import { asc, sql } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { pagedRows, stampText, type ExportContributor } from '../../tenancy/index.js';

import { toDto } from './read-model.js';

/** Where a prescription is in the order of the export: its patient, the instant it was made and its id. */
interface PrescriptionCursor {
  patientId: string;
  at: string;
  id: string;
}

/**
 * The prescriptions part of the cancellation export (e-prescription, "Audit, retention and tenant
 * isolation": prescriptions are included in the export). It is clinical and per professional: the
 * prescriptions a professional wrote and the ones of the patients they treat, with their items
 * decrypted with the key of the organization, their provider ids and their state. The context
 * carries a transaction that acts as that professional, so the clinical policies of the database
 * decide what is readable and the sharing scope never widens an export (a prescription never follows
 * it, D17). Cancelled prescriptions stay in, with their reason. They are read a page at a time and
 * decrypted as the exporter writes them.
 *
 * Like the clinical notes, it fails instead of delivering an empty record that would look complete
 * when it lacks the key service or the professional.
 */
export function exportPrescriptions(keys?: TenantKeys): ExportContributor {
  return ({ tx, professionalId, pageSize }) => {
    if (!keys) return Promise.reject(new Error('The prescriptions export needs the key service'));
    if (!professionalId) {
      return Promise.reject(new Error('The prescriptions export is made for one professional'));
    }

    // Narrowed here, for the generator below (a closure does not keep the narrowing of a parameter).
    const key: TenantKeys = keys;

    async function* prescriptions() {
      for await (const row of pagedRows<
        { row: typeof prescription.$inferSelect; cursorAt: string },
        PrescriptionCursor
      >({
        pageSize,
        fetch: (after, limit) =>
          tx
            .select({ row: prescription, cursorAt: stampText(prescription.createdAt) })
            .from(prescription)
            .where(
              after === null
                ? undefined
                : sql`(${prescription.patientId}, ${prescription.createdAt}, ${prescription.id}) > (${after.patientId}::uuid, ${after.at}::timestamptz, ${after.id}::uuid)`,
            )
            .orderBy(asc(prescription.patientId), asc(prescription.createdAt), asc(prescription.id))
            .limit(limit),
        cursorOf: ({ row, cursorAt }) => ({ patientId: row.patientId, at: cursorAt, id: row.id }),
      })) {
        yield await toDto(key, tx, row.row);
      }
    }

    return Promise.resolve({ prescriptions: prescriptions() });
  };
}
