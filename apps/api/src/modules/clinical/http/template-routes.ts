import { TemplatesResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { offeredTemplates } from '../application/templates.js';

import { runAsProfessional, type ClinicalRoutesDeps } from './guard.js';

/** The templates the signed-in professional is offered. */
export function templateRoutes(deps: ClinicalRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/clinical/templates',
      {
        config: { readOnly: 'read', permission: 'clinical.note.write' },
        schema: { response: { 200: TemplatesResponse } },
      },
      (request) =>
        runAsProfessional(deps, request, { resourceType: 'clinical_template' }, (tx, caller) =>
          offeredTemplates(tx, caller.professionalId),
        ),
    );
  };
}
