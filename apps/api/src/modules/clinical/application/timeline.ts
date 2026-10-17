import {
  deriveCurrentOdontogram,
  type CurrentOdontogramResponse,
  type DraftsResponse,
  type OdontogramEntry,
  type TimelineEntryDto,
  type TimelineQuery,
  type TimelineResponse,
} from '@consultorio/contracts';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';

import { anamnesis } from '../../../db/schema/anamnesis.js';
import { clinicalNote, noteVersion, type ClinicalNoteRow } from '../../../db/schema/clinical.js';
import { patient } from '../../../db/schema/patients.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { isTreating } from '../../patients/index.js';
import { headlineOf } from '../domain/note.js';

import type { Caller } from './notes.js';
import {
  addendaDtos,
  asTemplateKind,
  authorOf,
  loadDetails,
  namesOf,
  openContent,
  openErrorReason,
} from './repo.js';

export interface TimelineService {
  timeline(
    tx: Tx,
    caller: Caller,
    input: { patientId: string; query: TimelineQuery },
  ): Promise<TimelineResponse>;
  drafts(tx: Tx, caller: Caller): Promise<DraftsResponse>;
  odontogram(
    tx: Tx,
    caller: Caller,
    input: { patientId: string },
  ): Promise<CurrentOdontogramResponse>;
}

/** Whether a read of this entry rests on the sharing scope only (the audit marks it). */
function sharedFlag(note: ClinicalNoteRow, caller: Caller, treating: boolean) {
  return note.authorProfessionalId === caller.professionalId || treating
    ? {}
    : ({ reason: 'shared' } as const);
}

async function assertPatient(tx: Tx, patientId: string): Promise<void> {
  const [found] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(eq(patient.id, patientId));
  if (!found) throw new AppError('not_found');
}

/**
 * The clinical record of one patient as a chronological list (clinical-records, "Patient clinical
 * timeline and anamnesis link"). It shows only what the reader may read: the database policies
 * decide row by row, so an entry restricted to its author, a draft of a colleague or a psychology
 * note outside the shared scope is not here and is not counted. Every entry shown is an audited
 * read.
 */
export function createTimelineService(deps: { keys: TenantKeys }): TimelineService {
  const { keys } = deps;

  return {
    async timeline(tx, caller, { patientId, query }) {
      await assertPatient(tx, patientId);
      const treating = await isTreating(tx, caller.professionalId, patientId);

      const statuses = query.includeErrors
        ? (['signed', 'entered_in_error'] as const)
        : (['signed'] as const);
      const rows = await tx
        .select()
        .from(clinicalNote)
        .where(
          and(
            eq(clinicalNote.patientId, patientId),
            inArray(clinicalNote.status, [...statuses]),
            query.before === undefined ? undefined : lt(clinicalNote.id, query.before),
          ),
        )
        .orderBy(desc(clinicalNote.id))
        .limit(query.limit + 1);

      // Nothing readable and no care relationship: say no, and say it in the audit log. A
      // treating professional of an empty record is told there is nothing yet.
      if (rows.length === 0 && query.before === undefined && !treating) {
        throw new AccessRefused('timeline_not_readable');
      }

      const page = rows.slice(0, query.limit);
      const details = await loadDetails(tx, page);
      const names = await namesOf(tx, [
        ...page.map((note) => note.authorProfessionalId),
        ...page.flatMap((note) => (note.errorMarkedBy ? [note.errorMarkedBy] : [])),
        ...[...details.values()].flatMap((entry) =>
          entry.addenda.map((addendum) => addendum.authorProfessionalId),
        ),
      ]);

      const entries: TimelineEntryDto[] = [];
      for (const note of page) {
        const detail = details.get(note.id);
        const content = await openContent(keys, tx, note, detail?.version);
        const flag = sharedFlag(note, caller, treating);
        entries.push({
          noteId: note.id,
          encounterId: note.encounterId,
          templateKind: asTemplateKind(note.templateKind),
          templateVersion: note.templateVersion,
          status: note.status === 'entered_in_error' ? 'entered_in_error' : 'signed',
          visibility: note.visibility === 'author_only' ? 'author_only' : 'default',
          author: authorOf(names, note.authorProfessionalId),
          signedAt: note.signedAt?.toISOString() ?? null,
          createdAt: note.createdAt.toISOString(),
          headline: headlineOf(content),
          errorReason:
            note.status === 'entered_in_error' ? await openErrorReason(keys, tx, note) : null,
          addenda: await addendaDtos(keys, tx, detail?.addenda ?? [], names),
          basis:
            note.authorProfessionalId === caller.professionalId
              ? 'author'
              : treating
                ? 'treating'
                : 'shared',
        });
        await audit(tx, {
          action: 'clinical.note.read',
          outcome: 'allow',
          actor: caller.actor,
          resourceType: 'clinical_note',
          resourceId: note.id,
          patientId,
          ...flag,
          metadata: { templateKind: note.templateKind, via: 'timeline' },
        });
      }

      const [latest] = await tx
        .select({ version: anamnesis.version })
        .from(anamnesis)
        .where(eq(anamnesis.patientId, patientId))
        .orderBy(desc(anamnesis.version))
        .limit(1);

      return {
        entries,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        anamnesis: latest ? { version: latest.version } : null,
      };
    },

    async drafts(tx, caller) {
      const rows = await tx
        .select({
          note: clinicalNote,
          familyName: patient.familyName,
          givenNames: patient.givenNames,
        })
        .from(clinicalNote)
        .innerJoin(
          patient,
          and(eq(patient.tenantId, clinicalNote.tenantId), eq(patient.id, clinicalNote.patientId)),
        )
        .where(
          and(
            eq(clinicalNote.status, 'draft'),
            eq(clinicalNote.authorProfessionalId, caller.professionalId),
          ),
        )
        .orderBy(desc(clinicalNote.updatedAt))
        .limit(100);
      return {
        drafts: rows.map(({ note, familyName, givenNames }) => ({
          noteId: note.id,
          encounterId: note.encounterId,
          patientId: note.patientId,
          patientName: `${familyName}, ${givenNames}`,
          templateKind: asTemplateKind(note.templateKind),
          visibility: note.visibility === 'author_only' ? 'author_only' : 'default',
          draftRevision: note.draftRevision,
          createdAt: note.createdAt.toISOString(),
          updatedAt: note.updatedAt.toISOString(),
        })),
      };
    },

    async odontogram(tx, caller, { patientId }) {
      await assertPatient(tx, patientId);
      const treating = await isTreating(tx, caller.professionalId, patientId);
      const notes = await tx
        .select()
        .from(clinicalNote)
        .where(
          and(
            eq(clinicalNote.patientId, patientId),
            eq(clinicalNote.templateKind, 'odontology'),
            eq(clinicalNote.status, 'signed'),
          ),
        )
        .orderBy(desc(clinicalNote.id));
      if (notes.length === 0 && !treating) throw new AccessRefused('odontogram_not_readable');

      const versions = notes.length
        ? await tx
            .select()
            .from(noteVersion)
            .where(
              and(
                inArray(
                  noteVersion.noteId,
                  notes.map((note) => note.id),
                ),
                eq(noteVersion.versionNo, 1),
              ),
            )
        : [];
      const byNote = new Map(versions.map((version) => [version.noteId, version]));
      const entries: OdontogramEntry[] = [];
      for (const note of notes) {
        const content = await openContent(keys, tx, note, byNote.get(note.id));
        const odontogram = content['odontogram'];
        if (typeof odontogram === 'object' && odontogram !== null) {
          entries.push({
            signedAt: (note.signedAt ?? note.createdAt).toISOString(),
            authorProfessionalId: note.authorProfessionalId,
            odontogram: odontogram as OdontogramEntry['odontogram'],
          });
        }
        await audit(tx, {
          action: 'clinical.note.read',
          outcome: 'allow',
          actor: caller.actor,
          resourceType: 'clinical_note',
          resourceId: note.id,
          patientId,
          ...sharedFlag(note, caller, treating),
          metadata: { templateKind: note.templateKind, via: 'odontogram' },
        });
      }
      return { teeth: deriveCurrentOdontogram(entries), entries: entries.length };
    },
  };
}
