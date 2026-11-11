import { ConsentListResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError } from '../../../platform/http/problem.js';
import { readPatientContact } from '../../patients/index.js';
import { listConsentsForPatient } from '../application/read-model.js';

import { actorOf, transactionOf, type ConsentRoutesDeps } from './guard.js';

const PatientParams = z.strictObject({ id: z.uuid() });

export interface PatientRoutesDeps extends ConsentRoutesDeps {
  clock: () => Date;
}

/**
 * The consents of a patient, for the patient record. Whoever can open a patient's file may list
 * them (`patients.read`); what each role sees of every entry is decided by the read model (a
 * neutral label unless the role may see the title), so reception and the administration learn the
 * status and the dates and nothing else.
 */
export function patientRoutes(deps: PatientRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/consents',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: ConsentListResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), async (tx) => {
          if (!(await readPatientContact(tx, request.params.id))) throw new AppError('not_found');
          const consents = await listConsentsForPatient(tx, {
            actor,
            patientId: request.params.id,
            now: deps.clock(),
          });
          return { consents };
        });
      },
    );
  };
}
