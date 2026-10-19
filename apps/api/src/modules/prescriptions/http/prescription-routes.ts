import {
  CancelPrescriptionRequest,
  CorrectPrescriptionRequest,
  DownloadLinkResponse,
  GenericNameSearchResponse,
  IssuePrescriptionRequest,
  PrescriptionCapabilityDto,
  PrescriptionDto,
  PrescriptionExistenceResponse,
  PrescriptionListResponse,
  RegisterManualPrescriptionRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { refuseRequest } from '../../../platform/authz/refuse.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import type { PrescriptionDeps } from '../application/common.js';
import { capabilityOf } from '../application/connection.js';
import { cancelPrescription, registerManually } from '../application/corrections.js';
import { issueDocumentLink } from '../application/document.js';
import { PrescriptionDenied } from '../application/errors.js';
import { correctPrescription, createPrescription } from '../application/issue.js';
import { findPrescription, hiddenOrMissing, toDto } from '../application/read-model.js';
import {
  getPrescription,
  listForPatient,
  listMine,
  receptionExistence,
} from '../application/reads.js';
import { attemptSubmit } from '../application/submit.js';

import { runAsProfessional, type PrescriptionRoutesDeps } from './guard.js';

/** Searches the generic names a prescription is written with (the typeahead of the form). */
export interface GenericNameCatalog {
  search(query: string, limit: number): readonly string[];
}

export interface PrescriptionHttpDeps extends PrescriptionRoutesDeps {
  services: PrescriptionDeps;
  tokens: ActionTokens;
  catalog: GenericNameCatalog;
}

const IdParams = z.strictObject({ id: z.uuid() });
const PatientParams = z.strictObject({ patientId: z.uuid() });
const CatalogQuery = z.strictObject({ q: z.string().trim().max(60).default('') });

/** Most names the typeahead lists. */
const SUGGESTIONS = 10;

const SUBMIT_AUDITS = ['prescription.issued', 'prescription.failed'] as const;

/**
 * The prescriptions of the clinical record. Every route carries a `clinical.prescription.*`
 * permission, which only professionals hold: owners, admins and reception are refused before the
 * handler runs, with a deny entry in the audit trail. Issuing and cancelling are writes (refused in
 * a read-only organization); reading, the document link and the capability are reads.
 */
export function prescriptionRoutes(deps: PrescriptionHttpDeps) {
  const { services } = deps;

  /** The prescription as the professional reads it, with no entry of its own (the caller audited). */
  const dtoOf = (id: string) => async (tx: Parameters<typeof findPrescription>[0]) => {
    const row = await findPrescription(tx, id);
    if (!row) return hiddenOrMissing(tx, id);
    return toDto(services.keys, tx, row);
  };

  /**
   * The attempt that follows a request: the prescription was committed first, so a failure here
   * (anything unexpected) never loses it. The queue and the next request pick it up.
   */
  async function submitNow(
    request: FastifyRequest,
    id: string,
    patientId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    try {
      await runAsProfessional(
        deps,
        request,
        { resourceType: 'prescription', resourceId: id, patientId },
        (tx, caller) => attemptSubmit(tx, services, id, { ...options, actor: caller.actor }),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      request.log.error({ prescriptionId: id }, 'the first attempt to send a prescription failed');
    }
  }

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/prescriptions',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.prescription.write',
          audits: SUBMIT_AUDITS,
        },
        schema: {
          body: IssuePrescriptionRequest,
          response: { 200: PrescriptionDto, 201: PrescriptionDto },
        },
      },
      async (request, reply) => {
        const subject = { resourceType: 'prescription', patientId: request.body.patientId };
        const created = await runAsProfessional(deps, request, subject, (tx, caller) =>
          createPrescription(tx, services, caller, request.body),
        );
        // The prescription is committed before the provider is called: the mark of the attempt is
        // written on another connection and needs the row to exist.
        if (created.created) await submitNow(request, created.id, request.body.patientId);
        const dto = await runAsProfessional(
          deps,
          request,
          { ...subject, resourceId: created.id },
          dtoOf(created.id),
        );
        return reply.code(created.created ? 201 : 200).send(dto);
      },
    );

    typed.put(
      '/prescriptions/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.prescription.write',
          audits: SUBMIT_AUDITS,
        },
        schema: {
          params: IdParams,
          body: CorrectPrescriptionRequest,
          response: { 200: PrescriptionDto },
        },
      },
      async (request) => {
        const subject = { resourceType: 'prescription', resourceId: request.params.id };
        await runAsProfessional(deps, request, subject, (tx, caller) =>
          correctPrescription(tx, services, caller, {
            prescriptionId: request.params.id,
            request: request.body,
          }),
        );
        const patientId = await runAsProfessional(deps, request, subject, async (tx) => {
          const row = await findPrescription(tx, request.params.id);
          if (!row) return hiddenOrMissing(tx, request.params.id);
          return row.patientId;
        });
        await submitNow(request, request.params.id, patientId);
        return runAsProfessional(deps, request, subject, dtoOf(request.params.id));
      },
    );

    typed.post(
      '/prescriptions/:id/retry',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.prescription.write',
          audits: SUBMIT_AUDITS,
        },
        schema: { params: IdParams, response: { 200: PrescriptionDto } },
      },
      async (request) => {
        const subject = { resourceType: 'prescription', resourceId: request.params.id };
        const patientId = await runAsProfessional(deps, request, subject, async (tx, caller) => {
          const row = await findPrescription(tx, request.params.id);
          if (!row) return hiddenOrMissing(tx, request.params.id);
          if (row.authorProfessionalId !== caller.professionalId) {
            throw new PrescriptionDenied('prescription_not_author', {
              prescriptionId: row.id,
              patientId: row.patientId,
            });
          }
          // Only what the provider has not confirmed is sent again; a draft is corrected first.
          if (row.status !== 'pending_submission') throw new AppError('prescription_not_pending');
          return row.patientId;
        });
        await submitNow(request, request.params.id, patientId, { force: true });
        return runAsProfessional(deps, request, subject, dtoOf(request.params.id));
      },
    );

    typed.post(
      '/prescriptions/:id/cancel',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.prescription.write',
          audits: ['prescription.cancelled', 'prescription.failed'],
        },
        schema: {
          params: IdParams,
          body: CancelPrescriptionRequest,
          response: { 200: PrescriptionDto },
        },
      },
      async (request) => {
        const subject = { resourceType: 'prescription', resourceId: request.params.id };
        const outcome = await runAsProfessional(deps, request, subject, (tx, caller) =>
          cancelPrescription(tx, services, caller, {
            prescriptionId: request.params.id,
            request: request.body,
          }),
        );
        // Answered after the commit, so the entry that says the provider refused is kept.
        if (outcome === 'refused') throw new AppError('prescription_cancel_refused');
        if (outcome === 'unavailable') throw new AppError('prescription_provider_unavailable');
        return runAsProfessional(deps, request, subject, dtoOf(request.params.id));
      },
    );

    typed.post(
      '/prescriptions/:id/register-manual',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.prescription.write',
          audits: ['prescription.registered_manually'],
        },
        schema: {
          params: IdParams,
          body: RegisterManualPrescriptionRequest,
          response: { 200: PrescriptionDto },
        },
      },
      async (request) => {
        const subject = { resourceType: 'prescription', resourceId: request.params.id };
        await runAsProfessional(deps, request, subject, (tx, caller) =>
          registerManually(tx, services, caller, {
            prescriptionId: request.params.id,
            request: request.body,
          }),
        );
        return runAsProfessional(deps, request, subject, dtoOf(request.params.id));
      },
    );

    typed.get(
      '/prescriptions',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.prescription.read',
          audits: ['prescription.read'],
        },
        schema: { response: { 200: PrescriptionListResponse } },
      },
      async (request) => ({
        prescriptions: await runAsProfessional(
          deps,
          request,
          { resourceType: 'prescription' },
          (tx, caller) => listMine(tx, services, caller),
        ),
      }),
    );

    typed.get(
      '/prescriptions/capability',
      {
        config: { readOnly: 'read', permission: 'clinical.prescription.read' },
        schema: { response: { 200: PrescriptionCapabilityDto } },
      },
      (request) =>
        runAsProfessional(deps, request, { resourceType: 'prescription' }, (tx, caller) =>
          capabilityOf(tx, services, caller.professionalId),
        ),
    );

    typed.get(
      '/prescriptions/catalog',
      {
        config: { readOnly: 'read', permission: 'clinical.prescription.write' },
        schema: { querystring: CatalogQuery, response: { 200: GenericNameSearchResponse } },
      },
      (request) => ({ names: [...deps.catalog.search(request.query.q, SUGGESTIONS)] }),
    );

    typed.get(
      '/prescriptions/:id',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.prescription.read',
          audits: ['prescription.read'],
        },
        schema: { params: IdParams, response: { 200: PrescriptionDto } },
      },
      (request) =>
        runAsProfessional(
          deps,
          request,
          { resourceType: 'prescription', resourceId: request.params.id },
          (tx, caller) => getPrescription(tx, services, caller, request.params.id),
        ),
    );

    typed.post(
      '/prescriptions/:id/document-link',
      {
        // Asking for a link is a read; the download itself writes `prescription.downloaded` (the door of the files).
        config: { readOnly: 'read', permission: 'clinical.prescription.read', audits: 'none' },
        schema: { params: IdParams, response: { 200: DownloadLinkResponse } },
      },
      (request) => {
        const session = request.session;
        if (!session) throw new AppError('unauthenticated');
        return runAsProfessional(
          deps,
          request,
          { resourceType: 'prescription', resourceId: request.params.id },
          (tx) =>
            issueDocumentLink(tx, services, {
              prescriptionId: request.params.id,
              sessionId: session.sessionId,
              tokens: deps.tokens,
            }),
        );
      },
    );

    typed.get(
      '/patients/:patientId/prescriptions',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.prescription.read',
          audits: ['prescription.read'],
        },
        schema: { params: PatientParams, response: { 200: PrescriptionListResponse } },
      },
      async (request) => ({
        prescriptions: await runAsProfessional(
          deps,
          request,
          { resourceType: 'prescription', patientId: request.params.patientId },
          (tx, caller) => listForPatient(tx, services, caller, request.params.patientId),
        ),
      }),
    );

    // Reception learns that a prescription exists, when the organization lets it. No clinical
    // permission is involved: the database decides (setting on, active reception member), and an
    // owner or an admin who asks is refused and the refusal is audited.
    typed.get(
      '/patients/:patientId/prescriptions/existence',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: PrescriptionExistenceResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        if (!actor.roles.includes('reception') || actor.professionalId !== null) {
          return refuseRequest(deps.auditDeny, request, {
            reason: 'prescription_not_for_this_role',
            resourceType: 'prescription',
            patientId: request.params.patientId,
          });
        }
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          receptionExistence(tx, { patientId: request.params.patientId }),
        );
      },
    );
  };
}
