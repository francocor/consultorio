import type { AddendumDto, ClinicalAuthorDto, NoteDto, NoteStatus } from '@consultorio/contracts';
import { deriveContent, isTemplateKind } from '@consultorio/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  addendum,
  clinicalNote,
  encounter,
  noteVersion,
  type AddendumRow,
  type ClinicalNoteRow,
  type NoteVersionRow,
} from '../../../db/schema/clinical.js';
import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { isTreating } from '../../patients/index.js';
import { noteAccess } from '../domain/note.js';

/** Where the encrypted columns live; the ciphertext is bound to table, column and row. */
export const DRAFT_FIELD = { table: 'clinical_note', column: 'draft_content_enc' } as const;
export const VERSION_FIELD = { table: 'note_version', column: 'content_enc' } as const;
export const ADDENDUM_FIELD = { table: 'addendum', column: 'content_enc' } as const;

export interface NoteRecord {
  note: ClinicalNoteRow;
  appointmentId: string | null;
}

/** The note of an encounter or by its own id, with the appointment its encounter points at. */
export async function findNote(
  tx: Tx,
  where: { noteId: string } | { encounterId: string },
): Promise<NoteRecord | undefined> {
  const condition =
    'noteId' in where
      ? eq(clinicalNote.id, where.noteId)
      : eq(clinicalNote.encounterId, where.encounterId);
  const [row] = await tx
    .select({ note: clinicalNote, appointmentId: encounter.appointmentId })
    .from(clinicalNote)
    .innerJoin(
      encounter,
      and(
        eq(encounter.tenantId, clinicalNote.tenantId),
        eq(encounter.id, clinicalNote.encounterId),
      ),
    )
    .where(condition);
  return row;
}

/** How each professional appears in the directory (null when no name was set). */
export async function namesOf(
  tx: Tx,
  professionalIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(professionalIds)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: professional.id, name: membership.displayName })
    .from(professional)
    .innerJoin(
      membership,
      and(
        eq(membership.tenantId, professional.tenantId),
        eq(membership.id, professional.membershipId),
      ),
    )
    .where(inArray(professional.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function authorOf(names: Map<string, string | null>, id: string): ClinicalAuthorDto {
  return { professionalId: id, name: names.get(id) ?? null };
}

export async function versionOf(tx: Tx, noteId: string): Promise<NoteVersionRow | undefined> {
  const [row] = await tx
    .select()
    .from(noteVersion)
    .where(and(eq(noteVersion.noteId, noteId), eq(noteVersion.versionNo, 1)));
  return row;
}

export async function addendaOf(tx: Tx, noteId: string): Promise<AddendumRow[]> {
  return tx
    .select()
    .from(addendum)
    .where(eq(addendum.noteId, noteId))
    .orderBy(asc(addendum.createdAt), asc(addendum.id));
}

function parseObject(plain: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(plain.toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('stored clinical content is not an object');
  }
  return value as Record<string, unknown>;
}

/**
 * The content of an entry: the signed version when there is one, otherwise the working draft.
 * Decrypts with the tenant's data key; the plaintext lives in memory for this request only.
 */
export async function openContent(
  keys: TenantKeys,
  tx: Tx,
  note: ClinicalNoteRow,
  version?: NoteVersionRow,
): Promise<Record<string, unknown>> {
  if (version) {
    return parseObject(
      await keys.decryptField(tx, { ...VERSION_FIELD, rowId: version.id }, version.contentEnc),
    );
  }
  if (note.draftContentEnc) {
    return parseObject(
      await keys.decryptField(tx, { ...DRAFT_FIELD, rowId: note.id }, note.draftContentEnc),
    );
  }
  return {};
}

export async function openAddendum(keys: TenantKeys, tx: Tx, row: AddendumRow): Promise<string> {
  const plain = await keys.decryptField(tx, { ...ADDENDUM_FIELD, rowId: row.id }, row.contentEnc);
  const parsed: unknown = JSON.parse(plain.toString('utf8'));
  const text = (parsed as { text?: unknown }).text;
  if (typeof text !== 'string') throw new Error('stored addendum has no text');
  return text;
}

export async function addendaDtos(
  keys: TenantKeys,
  tx: Tx,
  rows: readonly AddendumRow[],
  names: Map<string, string | null>,
): Promise<AddendumDto[]> {
  const result: AddendumDto[] = [];
  for (const row of rows) {
    result.push({
      id: row.id,
      kind: row.kind === 'rectification' ? 'rectification' : 'correction',
      reason: row.reason,
      text: await openAddendum(keys, tx, row),
      author: authorOf(names, row.authorProfessionalId),
      createdAt: row.createdAt.toISOString(),
    });
  }
  return result;
}

export interface Viewer {
  professionalId: string;
  /** False while the organization is read-only (D16). */
  tenantActive: boolean;
}

/** Builds the response for one entry, as seen by one professional. */
export async function noteToDto(
  keys: TenantKeys,
  tx: Tx,
  record: NoteRecord,
  viewer: Viewer,
): Promise<NoteDto> {
  const { note } = record;
  const version = await versionOf(tx, note.id);
  const content = await openContent(keys, tx, note, version);
  const addendaRows = await addendaOf(tx, note.id);
  const markedBy = note.errorMarkedBy ? [note.errorMarkedBy] : [];
  const names = await namesOf(tx, [
    note.authorProfessionalId,
    ...markedBy,
    ...addendaRows.map((row) => row.authorProfessionalId),
  ]);
  const treating = await isTreating(tx, viewer.professionalId, note.patientId);
  const access = noteAccess({
    status: note.status as NoteStatus,
    isAuthor: note.authorProfessionalId === viewer.professionalId,
    treating,
    tenantActive: viewer.tenantActive,
  });

  return {
    id: note.id,
    encounterId: note.encounterId,
    patientId: note.patientId,
    appointmentId: record.appointmentId,
    author: authorOf(names, note.authorProfessionalId),
    status: note.status as NoteStatus,
    visibility: note.visibility === 'author_only' ? 'author_only' : 'default',
    templateKind: asTemplateKind(note.templateKind),
    templateVersion: note.templateVersion,
    draftRevision: note.draftRevision,
    content,
    derived: deriveContent(note.templateKind, content),
    contentHash: version?.contentHash ?? null,
    createdAt: note.createdAt.toISOString(),
    signedAt: note.signedAt?.toISOString() ?? null,
    error:
      note.status === 'entered_in_error' &&
      note.errorMarkedBy &&
      note.errorReason &&
      note.errorMarkedAt
        ? {
            reason: note.errorReason,
            markedBy: authorOf(names, note.errorMarkedBy),
            markedAt: note.errorMarkedAt.toISOString(),
          }
        : null,
    addenda: await addendaDtos(keys, tx, addendaRows, names),
    access,
  };
}

/** A stored template kind is always one the registry knows; anything else is corruption. */
export function asTemplateKind(value: string) {
  if (!isTemplateKind(value)) throw new Error('stored note has an unknown template kind');
  return value;
}
