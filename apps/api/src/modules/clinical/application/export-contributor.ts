import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import { clinicalNote } from '../../../db/schema/clinical.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

import { loadDetails, openAddendum, openContent } from './repo.js';

/**
 * The clinical part of the cancellation export (clinical-records, "Retention and availability";
 * tenancy). It is produced PER PROFESSIONAL: each one receives the signed entries of their own
 * patients, the ones they wrote or the ones of patients they treat. The context carries a
 * transaction that acts as that professional, so the clinical policies of the database decide what
 * is readable and the sharing scope never widens an export.
 *
 * Entries marked in error are left out (clinical-records, "Addenda and corrections": excluded from
 * exports unless explicitly included); their number is reported. Content is delivered decrypted, as
 * data; turning it into PDF is the exporter's job.
 *
 * The part needs the key service. Without it the contributor fails instead of delivering an empty
 * record that would look complete.
 */
export function exportClinical(keys?: TenantKeys): ExportContributor {
  return async ({ tx, professionalId }) => {
    if (!keys) throw new Error('The clinical export needs the key service');
    if (!professionalId) throw new Error('The clinical export is made for one professional');

    const treated = tx
      .select({ patientId: careRelationship.patientId })
      .from(careRelationship)
      .where(
        and(eq(careRelationship.professionalId, professionalId), eq(careRelationship.active, true)),
      );
    const own = or(
      eq(clinicalNote.authorProfessionalId, professionalId),
      inArray(clinicalNote.patientId, treated),
    );

    const notes = await tx
      .select()
      .from(clinicalNote)
      .where(and(eq(clinicalNote.status, 'signed'), own))
      .orderBy(asc(clinicalNote.patientId), asc(clinicalNote.id));
    const [excluded] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicalNote)
      .where(and(eq(clinicalNote.status, 'entered_in_error'), own));

    const details = await loadDetails(tx, notes);
    const entries = [];
    for (const note of notes) {
      const detail = details.get(note.id);
      const addenda = [];
      for (const row of detail?.addenda ?? []) {
        addenda.push({
          id: row.id,
          kind: row.kind,
          reason: row.reason,
          text: await openAddendum(keys, tx, row),
          authorProfessionalId: row.authorProfessionalId,
          createdAt: row.createdAt,
        });
      }
      entries.push({
        noteId: note.id,
        encounterId: note.encounterId,
        patientId: note.patientId,
        templateKind: note.templateKind,
        templateVersion: note.templateVersion,
        authorProfessionalId: note.authorProfessionalId,
        signedAt: note.signedAt,
        contentHash: detail?.version?.contentHash ?? null,
        content: await openContent(keys, tx, note, detail?.version),
        addenda,
      });
    }
    return { entries, excludedEnteredInError: excluded?.n ?? 0 };
  };
}
