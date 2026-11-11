import {
  AddAddendumRequest,
  HistoryResponse,
  MarkEnteredInErrorRequest,
  NoteDto,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AmendmentService } from '../application/amendments.js';

import { runAsProfessional, type ClinicalRoutesDeps } from './guard.js';

export interface AmendmentRoutesDeps extends ClinicalRoutesDeps {
  amendments: AmendmentService;
}

const IdParams = z.strictObject({ id: z.uuid() });

/** Addenda, "entered in error" marks and the history of an entry. */
export function amendmentRoutes(deps: AmendmentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/notes/:id/addenda',
      {
        config: {
          // The one clinical write a read-only organization still allows, and only for a
          // rectification: the service refuses any other kind there (D16).
          readOnly: 'rectification_addendum',
          permission: 'clinical.addendum.create',
          audits: ['clinical.note.amended'],
        },
        schema: { params: IdParams, body: AddAddendumRequest, response: { 201: NoteDto } },
      },
      async (request, reply) => {
        const note = await runAsProfessional(
          deps,
          request,
          { resourceType: 'clinical_note', resourceId: request.params.id },
          (tx, caller) =>
            deps.amendments.addAddendum(tx, caller, {
              noteId: request.params.id,
              request: request.body,
            }),
        );
        return reply.code(201).send(note);
      },
    );

    typed.post(
      '/notes/:id/entered-in-error',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.note.mark_error',
          audits: ['clinical.note.entered_in_error'],
        },
        schema: { params: IdParams, body: MarkEnteredInErrorRequest, response: { 200: NoteDto } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'clinical_note', resourceId: request.params.id },
          (tx, caller) =>
            deps.amendments.markEnteredInError(tx, caller, {
              noteId: request.params.id,
              request: request.body,
            }),
        ),
    );

    typed.get(
      '/notes/:id/versions',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.note.read',
          audits: ['clinical.note.read'],
        },
        schema: { params: IdParams, response: { 200: HistoryResponse } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'clinical_note', resourceId: request.params.id },
          (tx, caller) => deps.amendments.history(tx, caller, { noteId: request.params.id }),
        ),
    );
  };
}
