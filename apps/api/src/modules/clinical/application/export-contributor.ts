import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import { clinicalNote } from '../../../db/schema/clinical.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { pagedBatches, type ExportContributor } from '../../tenancy/index.js';

import { loadDetails, openAddendum, openAddendumReason, openContent } from './repo.js';

/** Where a note is in the order of the export: its patient and then its id. */
interface NoteCursor {
  patientId: string;
  id: string;
}

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
 * The entries are read a page of notes at a time, with the versions and addenda of that page, and
 * decrypted one by one as the exporter writes them: a professional with years of records never has
 * them all in memory.
 *
 * The part needs the key service. Without it the contributor fails instead of delivering an empty
 * record that would look complete.
 */
export function exportClinical(keys?: TenantKeys): ExportContributor {
  return async ({ tx, professionalId, pageSize }) => {
    if (!keys) throw new Error('The clinical export needs the key service');
    if (!professionalId) throw new Error('The clinical export is made for one professional');
    // Narrowed here, for the generator below (a closure does not keep the narrowing of a parameter).
    const key: TenantKeys = keys;

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

    const [excluded] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicalNote)
      .where(and(eq(clinicalNote.status, 'entered_in_error'), own));

    async function* entries() {
      for await (const notes of pagedBatches<typeof clinicalNote.$inferSelect, NoteCursor>({
        pageSize,
        fetch: (after, limit) =>
          tx
            .select()
            .from(clinicalNote)
            .where(
              and(
                eq(clinicalNote.status, 'signed'),
                own,
                after === null
                  ? undefined
                  : sql`(${clinicalNote.patientId}, ${clinicalNote.id}) > (${after.patientId}::uuid, ${after.id}::uuid)`,
              ),
            )
            .orderBy(asc(clinicalNote.patientId), asc(clinicalNote.id))
            .limit(limit),
        cursorOf: (note) => ({ patientId: note.patientId, id: note.id }),
      })) {
        const details = await loadDetails(tx, notes);
        for (const note of notes) {
          const detail = details.get(note.id);
          const addenda = [];
          for (const row of detail?.addenda ?? []) {
            addenda.push({
              id: row.id,
              kind: row.kind,
              reason: await openAddendumReason(key, tx, row),
              text: await openAddendum(key, tx, row),
              authorProfessionalId: row.authorProfessionalId,
              createdAt: row.createdAt,
            });
          }
          yield {
            noteId: note.id,
            encounterId: note.encounterId,
            patientId: note.patientId,
            templateKind: note.templateKind,
            templateVersion: note.templateVersion,
            authorProfessionalId: note.authorProfessionalId,
            signedAt: note.signedAt,
            contentHash: detail?.version?.contentHash ?? null,
            content: await openContent(key, tx, note, detail?.version),
            addenda,
          };
        }
      }
    }

    return { entries: entries(), excludedEnteredInError: excluded?.n ?? 0 };
  };
}
