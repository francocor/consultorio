import {
  SEARCH_ENTRY_CAP,
  type ClinicalSearchQuery,
  type SearchHitDto,
  type SearchResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import { clinicalNote, type ClinicalNoteRow } from '../../../db/schema/clinical.js';
import { patient } from '../../../db/schema/patients.js';
import { location } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { isTreating } from '../../patients/index.js';
import { findMatch, textsOf } from '../domain/search-text.js';

import type { Caller } from './notes.js';
import {
  asTemplateKind,
  authorOf,
  loadDetails,
  namesOf,
  openAddendum,
  openAddendumReason,
  openContent,
} from './repo.js';

export interface SearchService {
  search(
    tx: Tx,
    caller: Caller,
    input: { patientId: string; query: ClinicalSearchQuery },
  ): Promise<SearchResponse>;
}

/** The zone the dates of a range are read in: the one of the organization's first location. */
async function organizationTimeZone(tx: Tx): Promise<string> {
  const [first] = await tx
    .select({ timeZone: location.timeZone })
    .from(location)
    .orderBy(location.createdAt)
    .limit(1);
  return first?.timeZone ?? 'UTC';
}

/**
 * The only clinical search (design 4.3, clinical-records "Patient clinical timeline"): it runs over
 * ONE patient. The entries the reader may read are loaded (the database policies decide, newest
 * first, at most `cap`), decrypted in memory with the tenant's data key (unwrapped once for the
 * request), folded and compared. Nothing is indexed and no plaintext is kept. A record larger than
 * the cap needs a date range, so the cost of one request is bounded.
 */
export function createSearchService(deps: { keys: TenantKeys; cap?: number }): SearchService {
  const { keys } = deps;
  const cap = deps.cap ?? SEARCH_ENTRY_CAP;

  return {
    async search(tx, caller, { patientId, query }) {
      const [found] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(eq(patient.id, patientId));
      if (!found) throw new AppError('not_found');
      const treating = await isTreating(tx, caller.professionalId, patientId);

      const zone = await organizationTimeZone(tx);
      const inRange = [
        query.from === undefined
          ? undefined
          : sql`(${clinicalNote.signedAt} at time zone ${zone})::date >= ${query.from}::date`,
        query.to === undefined
          ? undefined
          : sql`(${clinicalNote.signedAt} at time zone ${zone})::date <= ${query.to}::date`,
      ];
      const where = and(
        eq(clinicalNote.patientId, patientId),
        eq(clinicalNote.status, 'signed'),
        ...inRange,
      );

      // One more than the cap tells whether the record is larger than it.
      const rows = await tx
        .select()
        .from(clinicalNote)
        .where(where)
        .orderBy(desc(clinicalNote.id))
        .limit(cap + 1);

      if (rows.length === 0 && !treating) throw new AccessRefused('search_not_readable');
      if (rows.length > cap && query.from === undefined && query.to === undefined) {
        throw new AppError('validation_failed', [
          { path: 'from', i18nKey: 'clinical.search.range_required' },
        ]);
      }

      const notes: ClinicalNoteRow[] = rows.slice(0, cap);
      const details = await loadDetails(tx, notes);
      const names = await namesOf(
        tx,
        notes.map((note) => note.authorProfessionalId),
      );

      const hits: SearchHitDto[] = [];
      for (const note of notes) {
        const detail = details.get(note.id);
        const content = await openContent(keys, tx, note, detail?.version);
        let snippet = textsOf(content).reduce<string | null>(
          (current, text) => current ?? findMatch(text, query.q)?.snippet ?? null,
          null,
        );
        let inAddendum = false;
        if (snippet === null) {
          for (const addendum of detail?.addenda ?? []) {
            const text = await openAddendum(keys, tx, addendum);
            snippet =
              findMatch(text, query.q)?.snippet ??
              findMatch(await openAddendumReason(keys, tx, addendum), query.q)?.snippet ??
              null;
            if (snippet !== null) {
              inAddendum = true;
              break;
            }
          }
        }
        if (snippet === null) continue;
        hits.push({
          noteId: note.id,
          encounterId: note.encounterId,
          templateKind: asTemplateKind(note.templateKind),
          author: authorOf(names, note.authorProfessionalId),
          signedAt: note.signedAt?.toISOString() ?? null,
          snippet,
          inAddendum,
        });
      }

      // One audited read per entry returned, as the timeline does, plus one for the search. The
      // term itself is not recorded: it can be as clinical as the text it looks for.
      for (const hit of hits) {
        const note = notes.find((candidate) => candidate.id === hit.noteId);
        await audit(tx, {
          action: 'clinical.note.read',
          outcome: 'allow',
          actor: caller.actor,
          resourceType: 'clinical_note',
          resourceId: hit.noteId,
          patientId,
          ...(note && (note.authorProfessionalId === caller.professionalId || treating)
            ? {}
            : { reason: 'shared' }),
          metadata: { templateKind: hit.templateKind, via: 'search' },
        });
      }
      await audit(tx, {
        action: 'clinical.search',
        outcome: 'allow',
        actor: caller.actor,
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        metadata: {
          hits: hits.length,
          scanned: notes.length,
          ranged: query.from !== undefined || query.to !== undefined,
        },
      });
      return { hits, scanned: notes.length };
    },
  };
}
