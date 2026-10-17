import {
  ClinicalSearchQuery,
  CurrentOdontogramResponse,
  DraftsResponse,
  SearchResponse,
  TimelineQuery,
  TimelineResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { SearchService } from '../application/search.js';
import type { TimelineService } from '../application/timeline.js';

import { runAsProfessional, type ClinicalRoutesDeps } from './guard.js';
import { searchRateLimit, type SearchLimitSettings } from './search-limit.js';

export interface TimelineRoutesDeps extends ClinicalRoutesDeps {
  timeline: TimelineService;
  search: SearchService;
  /** The per-user allowance of the search; without it the search is not limited. */
  searchLimit?: SearchLimitSettings | undefined;
}

const PatientParams = z.strictObject({ id: z.uuid() });

/**
 * The record of one patient (timeline, search, current odontogram) and the professional's own
 * drafts. There is deliberately NO route that searches the clinical text of several patients.
 */
export function timelineRoutes(deps: TimelineRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const limitSearch = deps.searchLimit ? [searchRateLimit(deps.searchLimit)] : [];

    typed.get(
      '/patients/:id/clinical/timeline',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.note.read',
          audits: ['clinical.note.read'],
        },
        schema: {
          params: PatientParams,
          querystring: TimelineQuery,
          response: { 200: TimelineResponse },
        },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'patient', resourceId: request.params.id, patientId: request.params.id },
          (tx, caller) =>
            deps.timeline.timeline(tx, caller, {
              patientId: request.params.id,
              query: request.query,
            }),
        ),
    );

    typed.get(
      '/patients/:id/clinical/search',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.search',
          audits: ['clinical.search', 'clinical.note.read'],
        },
        preHandler: limitSearch,
        schema: {
          params: PatientParams,
          querystring: ClinicalSearchQuery,
          response: { 200: SearchResponse },
        },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'patient', resourceId: request.params.id, patientId: request.params.id },
          (tx, caller) =>
            deps.search.search(tx, caller, { patientId: request.params.id, query: request.query }),
        ),
    );

    typed.get(
      '/patients/:id/clinical/odontogram',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.note.read',
          audits: ['clinical.note.read'],
        },
        schema: { params: PatientParams, response: { 200: CurrentOdontogramResponse } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'patient', resourceId: request.params.id, patientId: request.params.id },
          (tx, caller) => deps.timeline.odontogram(tx, caller, { patientId: request.params.id }),
        ),
    );

    typed.get(
      '/clinical/drafts',
      {
        config: { readOnly: 'read', permission: 'clinical.note.read' },
        schema: { response: { 200: DraftsResponse } },
      },
      (request) =>
        runAsProfessional(deps, request, { resourceType: 'clinical_note' }, (tx, caller) =>
          deps.timeline.drafts(tx, caller),
        ),
    );
  };
}
