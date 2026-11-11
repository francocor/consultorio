import type {
  AddAddendumRequest,
  HistoryItemDto,
  HistoryResponse,
  MarkEnteredInErrorRequest,
  NoteDto,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { addendum, clinicalNote, noteVersion } from '../../../db/schema/clinical.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { isTreating } from '../../patients/index.js';
import { canonicalJson, contentHash } from '../domain/canonical.js';

import { NoteConflict, NoteDenied, refusedEntry } from './errors.js';
import { readReason, type Caller } from './notes.js';
import {
  ADDENDUM_FIELD,
  ADDENDUM_REASON_FIELD,
  ERROR_REASON_FIELD,
  addendaOf,
  authorOf,
  findNote,
  namesOf,
  noteToDto,
  openAddendum,
  openAddendumReason,
  openErrorReason,
} from './repo.js';

export interface AmendmentService {
  addAddendum(
    tx: Tx,
    caller: Caller,
    input: { noteId: string; request: AddAddendumRequest },
  ): Promise<NoteDto>;
  markEnteredInError(
    tx: Tx,
    caller: Caller,
    input: { noteId: string; request: MarkEnteredInErrorRequest },
  ): Promise<NoteDto>;
  history(tx: Tx, caller: Caller, input: { noteId: string }): Promise<HistoryResponse>;
}

/**
 * Addenda, entries entered in error and the history of an entry (clinical-records, "Addenda and
 * corrections", "Version history"). Signed content is never touched: a correction is a new,
 * insert-only row, and marking an entry in error changes its status and nothing else.
 */
export function createAmendmentService(deps: { keys: TenantKeys }): AmendmentService {
  const { keys } = deps;

  return {
    async addAddendum(tx, caller, { noteId, request }) {
      const record = await findNote(tx, { noteId });
      if (!record) throw new AppError('not_found');
      const { note } = record;
      if (note.status !== 'signed') throw new NoteConflict('note_not_signed', refusedEntry(note));
      // Shared access is read-only: an addendum needs a care relationship with the patient.
      if (!(await isTreating(tx, caller.professionalId, note.patientId))) {
        throw new NoteDenied('addendum_not_treating', refusedEntry(note));
      }
      // While the organization is read-only only the patient's right to rectification survives (D16).
      if (!caller.tenantActive && request.kind !== 'rectification') {
        throw new AppError('tenant_read_only');
      }

      const id = uuidv7();
      const blob = await keys.encryptField(
        tx,
        { ...ADDENDUM_FIELD, rowId: id },
        canonicalJson({ text: request.text }),
      );
      const reasonBlob = await keys.encryptField(
        tx,
        { ...ADDENDUM_REASON_FIELD, rowId: id },
        request.reason,
      );
      await tx.insert(addendum).values({
        id,
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        noteId: note.id,
        patientId: note.patientId,
        authorProfessionalId: caller.professionalId,
        visibility: note.visibility,
        templateKind: note.templateKind,
        kind: request.kind,
        reasonEnc: reasonBlob,
        contentEnc: blob,
      });
      await audit(tx, {
        action: 'clinical.note.amended',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: note.id,
        patientId: note.patientId,
        metadata: { kind: request.kind, templateKind: note.templateKind, addendumId: id },
      });
      const fresh = await findNote(tx, { noteId });
      if (!fresh) throw new Error('the note just amended cannot be read');
      return noteToDto(keys, tx, fresh, caller);
    },

    async markEnteredInError(tx, caller, { noteId, request }) {
      const record = await findNote(tx, { noteId });
      if (!record) throw new AppError('not_found');
      const { note } = record;
      if (note.status === 'entered_in_error')
        throw new NoteConflict('note_already_marked', refusedEntry(note));
      const isAuthor = note.authorProfessionalId === caller.professionalId;
      // A draft is its author's; a signed entry is marked by its author or another treating one.
      const allowed =
        note.status === 'draft'
          ? isAuthor
          : isAuthor || (await isTreating(tx, caller.professionalId, note.patientId));
      if (!allowed) throw new NoteDenied('error_not_allowed', refusedEntry(note));

      // A draft that was never signed has nothing worth keeping: its working copy is dropped, so
      // it cannot stay readable to the colleagues who treat the patient (the database insists).
      const reasonBlob = await keys.encryptField(
        tx,
        { ...ERROR_REASON_FIELD, rowId: note.id },
        request.reason,
      );
      const [updated] = await tx
        .update(clinicalNote)
        .set({ status: 'entered_in_error', errorReasonEnc: reasonBlob, draftContentEnc: null })
        .where(and(eq(clinicalNote.id, note.id), eq(clinicalNote.status, note.status)))
        .returning({ id: clinicalNote.id });
      if (!updated) throw new NoteConflict('note_changed', refusedEntry(note));
      await audit(tx, {
        action: 'clinical.note.entered_in_error',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: note.id,
        patientId: note.patientId,
        metadata: { previousStatus: note.status, templateKind: note.templateKind },
      });
      const fresh = await findNote(tx, { noteId });
      if (!fresh) throw new Error('the note just marked cannot be read');
      return noteToDto(keys, tx, fresh, caller);
    },

    async history(tx, caller, { noteId }) {
      const record = await findNote(tx, { noteId });
      if (!record) throw new AppError('not_found');
      const { note } = record;
      const versions = await tx
        .select()
        .from(noteVersion)
        .where(eq(noteVersion.noteId, note.id))
        .orderBy(noteVersion.versionNo);
      const addenda = await addendaOf(tx, note.id);
      const names = await namesOf(tx, [
        note.authorProfessionalId,
        ...(note.errorMarkedBy ? [note.errorMarkedBy] : []),
        ...addenda.map((row) => row.authorProfessionalId),
      ]);

      const items: HistoryItemDto[] = versions.map((version) => ({
        type: 'version',
        versionNo: version.versionNo,
        templateVersion: version.templateVersion,
        contentHash: version.contentHash,
        author: authorOf(names, version.authorProfessionalId),
        at: version.signedAt.toISOString(),
      }));
      for (const row of addenda) {
        const text = await openAddendum(keys, tx, row);
        const reason = await openAddendumReason(keys, tx, row);
        items.push({
          type: 'addendum',
          id: row.id,
          kind: row.kind === 'rectification' ? 'rectification' : 'correction',
          reason,
          contentHash: contentHash({ kind: row.kind, reason, text }),
          author: authorOf(names, row.authorProfessionalId),
          at: row.createdAt.toISOString(),
        });
      }
      if (note.status === 'entered_in_error' && note.errorMarkedBy && note.errorMarkedAt) {
        items.push({
          type: 'entered_in_error',
          reason: (await openErrorReason(keys, tx, note)) ?? '',
          author: authorOf(names, note.errorMarkedBy),
          at: note.errorMarkedAt.toISOString(),
        });
      }
      // Time order; at the same instant the signature comes first and the error mark last.
      const rank = { version: 0, addendum: 1, entered_in_error: 2 } as const;
      items.sort((a, b) => a.at.localeCompare(b.at) || rank[a.type] - rank[b.type]);

      const treating = await isTreating(tx, caller.professionalId, note.patientId);
      await audit(tx, {
        action: 'clinical.note.read',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: note.id,
        patientId: note.patientId,
        ...readReason(note, caller, treating),
        metadata: { templateKind: note.templateKind, via: 'history' },
      });
      return { noteId: note.id, items };
    },
  };
}
