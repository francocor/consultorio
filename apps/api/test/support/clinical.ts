import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { clinicalNote, encounter, type ClinicalNoteRow } from '../../src/db/schema/clinical.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';

/**
 * Raw access to the clinical tables as a given professional, for tests that are about the
 * database rules (policies, triggers) and not about the services. The transaction acts exactly as
 * the application does for a professional: `app.professional_id` is set, so the clinical policies
 * and the triggers see who is writing.
 */
export function asProfessional<T>(
  handle: DbHandle,
  tenantId: string,
  professionalId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return createWithTenant(handle.db)(
    { tenantId, userId: randomUUID(), actingProfessionalId: professionalId },
    fn,
  );
}

export interface OpenedNote {
  encounterId: string;
  noteId: string;
}

/** Opens an encounter and its draft note for a patient, as their author. */
export async function openDraft(
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    authorId: string;
    templateKind?: string;
    visibility?: 'default' | 'author_only';
  },
): Promise<OpenedNote> {
  const templateKind = input.templateKind ?? 'general';
  const visibility = input.visibility ?? 'default';
  const [opened] = await tx
    .insert(encounter)
    .values({
      tenantId: input.tenantId,
      patientId: input.patientId,
      authorProfessionalId: input.authorId,
      templateKind,
      visibility,
    })
    .returning({ id: encounter.id });
  if (!opened) throw new Error('encounter insert returned no row');
  const [note] = await tx
    .insert(clinicalNote)
    .values({
      tenantId: input.tenantId,
      encounterId: opened.id,
      patientId: input.patientId,
      authorProfessionalId: input.authorId,
      templateKind,
      templateVersion: 1,
      visibility,
    })
    .returning({ id: clinicalNote.id });
  if (!note) throw new Error('note insert returned no row');
  return { encounterId: opened.id, noteId: note.id };
}

/** Signs a draft the way the service does: the version first, then the status. */
export async function signDraft(
  tx: Tx,
  note: Pick<ClinicalNoteRow, 'id' | 'tenantId' | 'patientId' | 'authorProfessionalId'> & {
    templateKind: string;
    visibility: string;
  },
): Promise<string> {
  const versionId = randomUUID();
  await tx.execute(
    sql`INSERT INTO note_version (id, tenant_id, note_id, patient_id, author_professional_id, visibility,
                                  template_kind, template_version, version_no, content_enc, content_hash)
        VALUES (${versionId}, ${note.tenantId}, ${note.id}, ${note.patientId}, ${note.authorProfessionalId},
                ${note.visibility}, ${note.templateKind}, 1, 1, ${Buffer.from([1, 2, 3])}, ${'a'.repeat(64)})`,
  );
  await tx.execute(
    sql`UPDATE clinical_note SET status = 'signed', signed_at = now(), draft_content_enc = NULL WHERE id = ${note.id}`,
  );
  return versionId;
}
