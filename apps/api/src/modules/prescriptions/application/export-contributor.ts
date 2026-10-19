import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The prescriptions part of the cancellation export. Seam skeleton of Stage 5: its shape and its
 * registration (and the test that a module cannot be forgotten) exist from the start; the e-Rx
 * track (A3, S5.20) fills it in. No table exists yet, so there is nothing to leave out.
 *
 * It is clinical and per professional: the prescriptions a professional issued, with their items
 * decrypted with the key of the organization, their provider ids and their state. The context
 * carries a transaction that acts as that professional, so the clinical policies of the database
 * decide what is readable and the sharing scope never widens an export. Like the clinical notes,
 * it fails instead of delivering an empty record that would look complete when it lacks the key
 * service or the professional.
 */
export function exportPrescriptions(keys?: TenantKeys): ExportContributor {
  return ({ professionalId }) => {
    if (!keys) return Promise.reject(new Error('The prescriptions export needs the key service'));
    if (!professionalId) {
      return Promise.reject(new Error('The prescriptions export is made for one professional'));
    }
    return Promise.resolve({ prescriptions: [] });
  };
}
