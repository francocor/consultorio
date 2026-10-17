import { NoteDto, OpenEncounterRequest, SaveDraftRequest } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { NoteService } from '../application/notes.js';

import { runAsProfessional, type ClinicalRoutesDeps } from './guard.js';

export interface NoteRoutesDeps extends ClinicalRoutesDeps {
  notes: NoteService;
}

const IdParams = z.strictObject({ id: z.uuid() });

const SignRequest = z.object({
  /** The revision the author saw; a newer one means another tab saved in between. */
  expectedRevision: z.number().int().min(0),
});

/**
 * Encounter notes (clinical-records). The routes carry the `clinical.note.*` permissions, which
 * only professionals hold: owners, admins and reception are refused before the handler runs.
 */
export function noteRoutes(deps: NoteRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/encounters',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.note.write',
          audits: ['clinical.note.created'],
        },
        schema: { body: OpenEncounterRequest, response: { 201: NoteDto } },
      },
      async (request, reply) => {
        const note = await runAsProfessional(
          deps,
          request,
          { resourceType: 'encounter', patientId: request.body.patientId },
          (tx, caller) => deps.notes.open(tx, caller, request.body),
        );
        return reply.code(201).send(note);
      },
    );

    typed.put(
      '/encounters/:id/note/draft',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.note.write',
          audits: ['clinical.note.updated'],
        },
        schema: { params: IdParams, body: SaveDraftRequest, response: { 200: NoteDto } },
      },
      (request) =>
        runAsProfessional(deps, request, { resourceType: 'clinical_note' }, (tx, caller) =>
          deps.notes.saveDraft(tx, caller, {
            encounterId: request.params.id,
            request: request.body,
          }),
        ),
    );

    typed.post(
      '/notes/:id/sign',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.note.sign',
          audits: ['clinical.note.signed'],
        },
        schema: { params: IdParams, body: SignRequest, response: { 200: NoteDto } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'clinical_note', resourceId: request.params.id },
          (tx, caller) =>
            deps.notes.sign(tx, caller, {
              noteId: request.params.id,
              expectedRevision: request.body.expectedRevision,
            }),
        ),
    );

    typed.get(
      '/notes/:id',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.note.read',
          audits: ['clinical.note.read'],
        },
        schema: { params: IdParams, response: { 200: NoteDto } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'clinical_note', resourceId: request.params.id },
          (tx, caller) => deps.notes.get(tx, caller, { noteId: request.params.id }),
        ),
    );
  };
}
