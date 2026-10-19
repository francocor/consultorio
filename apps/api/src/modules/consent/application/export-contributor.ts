import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The consent parts of the cancellation export. Seam skeleton of Stage 5: the shape of the two
 * parts and their registration (and the test that a module cannot be forgotten) exist from the
 * start; the consent track (A2, S5.15) fills them in. No table exists yet, so there is nothing to
 * leave out.
 *
 * - Administrative, for the owner: the templates and their versions, and the requests as dates and
 *   states, never the text a patient signed.
 * - Clinical, per professional: the signed consents of the patients that professional treats, with
 *   their evidence and fingerprint. The context carries a transaction that acts as that
 *   professional, so the clinical policies of the database decide what is readable. Like the
 *   clinical notes, it fails instead of delivering an empty record that would look complete when
 *   it lacks the key service or the professional.
 */
export const exportConsentTemplates: ExportContributor = () => Promise.resolve({ templates: [] });

export function exportSignedConsents(keys?: TenantKeys): ExportContributor {
  return ({ professionalId }) => {
    if (!keys) return Promise.reject(new Error('The consent export needs the key service'));
    if (!professionalId) {
      return Promise.reject(new Error('The consent export is made for one professional'));
    }
    return Promise.resolve({ consents: [] });
  };
}
