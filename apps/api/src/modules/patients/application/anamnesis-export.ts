import { AnamnesisContent } from '@consultorio/contracts';
import { and, asc, eq, inArray, or } from 'drizzle-orm';

import { anamnesis } from '../../../db/schema/anamnesis.js';
import { careRelationship } from '../../../db/schema/care.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

const FIELD = { table: 'anamnesis', column: 'content_enc' } as const;

/**
 * The anamnesis part of the cancellation export (patients, "Anamnesis is clinical data"; tenancy,
 * "Tenant cancellation export": the clinical export carries the anamnesis). It is clinical and per
 * professional, like the entries: every saved version of the anamnesis of the patients a
 * professional wrote for or treats, decrypted with the key of the organization. The context carries
 * a transaction that acts as that professional, so the clinical policies of the database decide what
 * is readable and the sharing scope never widens an export. Every version stays: an anamnesis is
 * never overwritten, and the history is part of the record.
 *
 * Like the other clinical parts, it fails instead of delivering an empty record that would look
 * complete when it lacks the key service or the professional.
 */
export function exportAnamnesis(keys?: TenantKeys): ExportContributor {
  return async ({ tx, professionalId }) => {
    if (!keys) throw new Error('The anamnesis export needs the key service');
    if (!professionalId) throw new Error('The anamnesis export is made for one professional');

    const treated = tx
      .select({ patientId: careRelationship.patientId })
      .from(careRelationship)
      .where(
        and(eq(careRelationship.professionalId, professionalId), eq(careRelationship.active, true)),
      );
    const rows = await tx
      .select()
      .from(anamnesis)
      .where(
        or(
          eq(anamnesis.authorProfessionalId, professionalId),
          inArray(anamnesis.patientId, treated),
        ),
      )
      .orderBy(asc(anamnesis.patientId), asc(anamnesis.version));

    const versions = [];
    for (const row of rows) {
      const plain = await keys.decryptField(tx, { ...FIELD, rowId: row.id }, row.contentEnc);
      const content = AnamnesisContent.parse(JSON.parse(plain.toString('utf8')));
      versions.push({
        patientId: row.patientId,
        version: row.version,
        savedAt: row.createdAt,
        authorProfessionalId: row.authorProfessionalId,
        content,
      });
    }
    return { anamnesis: versions };
  };
}
