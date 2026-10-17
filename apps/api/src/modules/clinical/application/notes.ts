import {
  latestTemplate,
  validateDraftContent,
  validateSignContent,
  type FieldError,
  type NoteDto,
  type OpenEncounterRequest,
  type SaveDraftRequest,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { clinicalNote, encounter, noteVersion } from '../../../db/schema/clinical.js';
import { patient } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { isTreating } from '../../patients/index.js';
import { canonicalJson, contentHash } from '../domain/canonical.js';

import { NoteConflict, NoteDenied, refusedEntry } from './errors.js';
import {
  DRAFT_FIELD,
  VERSION_FIELD,
  findNote,
  noteToDto,
  openContent,
  type NoteRecord,
  type Viewer,
} from './repo.js';

type Actor = AuditActor & { userId: string };

/** What a service needs to know about who is acting and about the organization. */
export interface Caller extends Viewer {
  actor: Actor;
}

/**
 * Looks an appointment up by id inside the transaction of the request. The agenda module owns the
 * appointments, so the clinical module only receives this port (composition root); `null` when the
 * appointment does not exist or the caller cannot see it.
 */
export type AppointmentLookup = (
  tx: Tx,
  appointmentId: string,
) => Promise<{ patientId: string; professionalId: string } | null>;

/** The most a note may weigh once serialized: a clinical note is text, not a file store. */
const MAX_CONTENT_BYTES = 200_000;

export interface NoteService {
  open(tx: Tx, caller: Caller, request: OpenEncounterRequest): Promise<NoteDto>;
  saveDraft(
    tx: Tx,
    caller: Caller,
    input: { encounterId: string; request: SaveDraftRequest },
  ): Promise<NoteDto>;
  sign(
    tx: Tx,
    caller: Caller,
    input: { noteId: string; expectedRevision: number },
  ): Promise<NoteDto>;
  get(tx: Tx, caller: Caller, input: { noteId: string }): Promise<NoteDto>;
}

function fieldErrors(errors: readonly { path: string; i18nKey: string }[]): FieldError[] {
  return errors.map((error) => ({ path: error.path, i18nKey: error.i18nKey }));
}

function assertSize(content: unknown): void {
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_CONTENT_BYTES) {
    throw new AppError('validation_failed', [{ path: '(root)', i18nKey: 'validation.too_long' }]);
  }
}

/** Marks a read as shared when the reader neither wrote the entry nor treats the patient. */
export function readReason(note: NoteRecord['note'], viewer: Viewer, treating: boolean) {
  return note.authorProfessionalId === viewer.professionalId || treating
    ? {}
    : ({ reason: 'shared' } as const);
}

/**
 * Encounter notes: open, save the draft, sign and read (clinical-records, "Encounter notes",
 * "Draft, signing and immutability"). Every function runs inside a transaction that acts as the
 * professional, so the clinical policies of the database see them too, and writes its audit entry
 * in the same transaction: an action that cannot be audited does not happen.
 */
export function createNoteService(deps: {
  keys: TenantKeys;
  /** Without it no encounter can be linked to an appointment: the link cannot be checked. */
  appointments?: AppointmentLookup | undefined;
}): NoteService {
  const { keys } = deps;

  /** Does anybody have a clinical footprint or a care relationship with this patient? */
  async function hasFootprint(tx: Tx, patientId: string): Promise<boolean> {
    const result = await tx.execute<{ found: boolean }>(
      sql`SELECT app.has_clinical_footprint(${patientId}::uuid) AS found`,
    );
    return result.rows[0]?.found === true;
  }

  async function lock(tx: Tx, noteId: string) {
    const [row] = await tx
      .select()
      .from(clinicalNote)
      .where(eq(clinicalNote.id, noteId))
      .for('update');
    return row;
  }

  return {
    async open(tx, caller, request) {
      const [found] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(eq(patient.id, request.patientId));
      if (!found) throw new AppError('not_found');
      const template = latestTemplate(request.templateKind);
      if (!template) throw new AppError('validation_failed');

      // An appointment, when named, is the appointment of this patient with this professional.
      if (request.appointmentId !== undefined) {
        const appointment = await deps.appointments?.(tx, request.appointmentId);
        if (
          !appointment ||
          appointment.patientId !== request.patientId ||
          appointment.professionalId !== caller.professionalId
        ) {
          throw new AccessRefused('appointment_mismatch');
        }
      }
      // Decision D20: opening an encounter does not create the care relationship, it needs one
      // that comes from elsewhere (an appointment, an assignment or a signed encounter). The one
      // exception is a patient nobody has written about yet.
      if (
        !(await isTreating(tx, caller.professionalId, request.patientId)) &&
        (await hasFootprint(tx, request.patientId))
      ) {
        throw new AccessRefused('encounter_requires_relationship');
      }

      const visibility = request.visibility ?? 'default';
      const encounterId = uuidv7();
      const noteId = uuidv7();
      const tenantId = sql`current_setting('app.tenant_id')::uuid`;
      await tx.insert(encounter).values({
        id: encounterId,
        tenantId,
        patientId: request.patientId,
        authorProfessionalId: caller.professionalId,
        appointmentId: request.appointmentId ?? null,
        templateKind: template.kind,
        visibility,
      });
      await tx.insert(clinicalNote).values({
        id: noteId,
        tenantId,
        encounterId,
        patientId: request.patientId,
        authorProfessionalId: caller.professionalId,
        templateKind: template.kind,
        templateVersion: template.version,
        visibility,
      });
      await audit(tx, {
        action: 'clinical.note.created',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: noteId,
        patientId: request.patientId,
        metadata: {
          templateKind: template.kind,
          visibility,
          appointmentLinked: request.appointmentId !== undefined,
        },
      });
      const record = await findNote(tx, { noteId });
      if (!record) throw new Error('the note just created cannot be read');
      return noteToDto(keys, tx, record, caller);
    },

    async saveDraft(tx, caller, { encounterId, request }) {
      const record = await findNote(tx, { encounterId });
      if (!record) throw new AppError('not_found');
      const { note } = record;
      // A signed entry (or one marked in error) never changes, for anybody.
      if (note.status !== 'draft') throw new NoteConflict('note_not_draft', refusedEntry(note));
      if (note.authorProfessionalId !== caller.professionalId) {
        throw new NoteDenied('note_not_author', refusedEntry(note));
      }

      const checked = validateDraftContent(
        note.templateKind,
        note.templateVersion,
        request.content,
      );
      if (!checked.ok) throw new AppError('validation_failed', fieldErrors(checked.errors));
      assertSize(checked.content);

      const blob = await keys.encryptField(
        tx,
        { ...DRAFT_FIELD, rowId: note.id },
        canonicalJson(checked.content),
      );
      const [updated] = await tx
        .update(clinicalNote)
        .set({
          draftContentEnc: blob,
          draftRevision: request.baseRevision + 1,
          ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
        })
        .where(
          and(
            eq(clinicalNote.id, note.id),
            eq(clinicalNote.draftRevision, request.baseRevision),
            eq(clinicalNote.status, 'draft'),
          ),
        )
        .returning({ id: clinicalNote.id });
      if (!updated) {
        // Somebody (another tab) saved or signed first. Tell which, without guessing.
        const now = await findNote(tx, { noteId: note.id });
        if (now && now.note.status !== 'draft')
          throw new NoteConflict('note_not_draft', refusedEntry(note));
        throw new AppError('stale_revision');
      }
      await audit(tx, {
        action: 'clinical.note.updated',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: note.id,
        patientId: note.patientId,
        metadata: {
          revision: request.baseRevision + 1,
          templateKind: note.templateKind,
          visibility: request.visibility ?? note.visibility,
        },
      });
      const fresh = await findNote(tx, { noteId: note.id });
      if (!fresh) throw new Error('the draft just saved cannot be read');
      return noteToDto(keys, tx, fresh, caller);
    },

    async sign(tx, caller, { noteId, expectedRevision }) {
      const note = await lock(tx, noteId);
      if (!note) throw new AppError('not_found');
      if (note.status !== 'draft') throw new NoteConflict('note_not_draft', refusedEntry(note));
      if (note.authorProfessionalId !== caller.professionalId) {
        throw new NoteDenied('note_not_author', refusedEntry(note));
      }
      if (expectedRevision !== note.draftRevision) {
        throw new AppError('stale_revision');
      }

      const draft = await openContent(keys, tx, note);
      const checked = validateSignContent(note.templateKind, note.templateVersion, draft);
      if (!checked.ok) throw new AppError('validation_failed', fieldErrors(checked.errors));

      // The text that is encrypted is the canonical one, so its SHA-256 is the stored hash.
      const canonical = canonicalJson(checked.content);
      const hash = contentHash(checked.content);
      const versionId = uuidv7();
      const blob = await keys.encryptField(tx, { ...VERSION_FIELD, rowId: versionId }, canonical);
      // The version first, then the status: the trigger refuses to sign without one.
      await tx.insert(noteVersion).values({
        id: versionId,
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        noteId: note.id,
        patientId: note.patientId,
        authorProfessionalId: note.authorProfessionalId,
        visibility: note.visibility,
        templateKind: note.templateKind,
        templateVersion: note.templateVersion,
        versionNo: 1,
        contentEnc: blob,
        contentHash: hash,
      });
      await tx
        .update(clinicalNote)
        .set({ status: 'signed', draftContentEnc: null })
        .where(and(eq(clinicalNote.id, note.id), eq(clinicalNote.status, 'draft')));
      await audit(tx, {
        action: 'clinical.note.signed',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: note.id,
        patientId: note.patientId,
        metadata: {
          templateKind: note.templateKind,
          templateVersion: note.templateVersion,
          versionNo: 1,
          contentHash: hash,
        },
      });
      const fresh = await findNote(tx, { noteId: note.id });
      if (!fresh) throw new Error('the note just signed cannot be read');
      return noteToDto(keys, tx, fresh, caller);
    },

    async get(tx, caller, { noteId }) {
      const record = await findNote(tx, { noteId });
      // The policies hide what this professional may not read, and a missing entry looks the same.
      if (!record) throw new AppError('not_found');
      const treating = await isTreating(tx, caller.professionalId, record.note.patientId);
      await audit(tx, {
        action: 'clinical.note.read',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'clinical_note',
        resourceId: record.note.id,
        patientId: record.note.patientId,
        ...readReason(record.note, caller, treating),
        metadata: { templateKind: record.note.templateKind, via: 'note' },
      });
      return noteToDto(keys, tx, record, caller);
    },
  };
}
