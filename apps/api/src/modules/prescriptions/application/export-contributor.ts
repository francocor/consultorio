import { asc } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

import { toDto } from './read-model.js';

/**
 * The prescriptions part of the cancellation export (e-prescription, "Audit, retention and tenant
 * isolation": prescriptions are included in the export). It is clinical and per professional: the
 * prescriptions a professional wrote and the ones of the patients they treat, with their items
 * decrypted with the key of the organization, their provider ids and their state. The context
 * carries a transaction that acts as that professional, so the clinical policies of the database
 * decide what is readable and the sharing scope never widens an export (a prescription never follows
 * it, D17). Cancelled prescriptions stay in, with their reason.
 *
 * Like the clinical notes, it fails instead of delivering an empty record that would look complete
 * when it lacks the key service or the professional.
 */
export function exportPrescriptions(keys?: TenantKeys): ExportContributor {
  return async ({ tx, professionalId }) => {
    if (!keys) throw new Error('The prescriptions export needs the key service');
    if (!professionalId) {
      throw new Error('The prescriptions export is made for one professional');
    }
    const rows = await tx
      .select()
      .from(prescription)
      .orderBy(asc(prescription.patientId), asc(prescription.createdAt), asc(prescription.id));
    const prescriptions = [];
    for (const row of rows) prescriptions.push(await toDto(keys, tx, row));
    return { prescriptions };
  };
}
