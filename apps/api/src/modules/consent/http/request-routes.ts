import {
  AppointmentConsentStatusDto,
  ConsentRequestDto,
  ConsentRequirementDto,
  ConsentRequirementsResponse,
  ConsentSigningViewDto,
  CreateConsentRequestRequest,
  CreateConsentRequestResponse,
  RevokeConsentRequest,
  SetConsentRequirementRequest,
  SignConsentRequest,
  SignedConsentDto,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Actor } from '../../../platform/authz/actor.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { AppointmentConsentService } from '../application/appointment-consent.js';
import { renderSignedDocument } from '../application/documents.js';
import type { ConsentNotice } from '../application/notice.js';
import type { RequestService } from '../application/request-consent.js';
import type { RevocationService } from '../application/revoke-consent.js';
import type { SigningService } from '../application/sign-consent.js';
import { auditRead, openSignedRecord, toSignedConsentDto } from '../application/signed-record.js';

import {
  actorOf,
  auditActorOf,
  transactionOf,
  withRefusals,
  type ConsentRoutesDeps,
} from './guard.js';

const RequestParams = z.strictObject({ id: z.uuid() });
const AppointmentParams = z.strictObject({ id: z.uuid() });
const AppointmentTypeParams = z.strictObject({ id: z.uuid() });

export interface RequestRoutesDeps extends ConsentRoutesDeps {
  keys: TenantKeys;
  clock: () => Date;
  requests: RequestService;
  signing: SigningService;
  revocation: RevocationService;
  appointments: AppointmentConsentService;
  notice: ConsentNotice;
}

/**
 * Requests, signing, revocation and the signed record (informed-consent, tasks 5.13 to 5.15).
 *
 * - Who asks, signs on the device at reception, declines or records a revocation in person holds
 *   `consent.request` (professional and reception): they handle the request, never the signed
 *   record. Reception reads no signature; the database does not let it.
 * - The signed record and its printable document are for `clinical.consent.read` (a professional
 *   who may read the patient); every read is audited as `consent.read`.
 * - Revoking is a patient-protective write: it works in a read-only organization.
 */
export function requestRoutes(deps: RequestRoutesDeps) {
  const subject = (request: FastifyRequest) => ({
    resourceType: 'consent_request',
    resourceId: z.uuid().safeParse((request.params as { id?: unknown }).id).data,
  });
  const staff = (actor: Actor) => ({ kind: 'staff' as const, userId: actor.userId });

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/consents/requests',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.request',
          audits: ['consent.requested', 'consent.expired'],
        },
        schema: {
          body: CreateConsentRequestRequest,
          response: { 201: CreateConsentRequestResponse },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(transactionOf(actor), (tx) =>
          deps.requests.create(tx, {
            actor: auditActorOf(request, actor),
            request: request.body,
          }),
        );
        // After the commit: a notice that cannot be sent never undoes the request.
        const notice =
          created.method === 'portal'
            ? await deps.notice.notifyRequest(actor.tenantId, created.id)
            : 'not_needed';
        return reply.code(201).send({ request: created, notice });
      },
    );

    typed.get(
      '/consents/requests/:id/signing',
      {
        config: { readOnly: 'read', permission: 'consent.request' },
        schema: { params: RequestParams, response: { 200: ConsentSigningViewDto } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.signing.view(tx, { requestId: request.params.id, recorder: staff(actor) }),
        );
      },
    );

    typed.post(
      '/consents/requests/:id/sign',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.request',
          audits: ['consent.signed'],
        },
        schema: {
          params: RequestParams,
          body: SignConsentRequest,
          response: { 200: ConsentRequestDto },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.signing.sign(tx, {
            requestId: request.params.id,
            recorder: staff(actor),
            auditActor: auditActorOf(request, actor),
            request: request.body,
          }),
        );
      },
    );

    typed.post(
      '/consents/requests/:id/decline',
      {
        // The patient chose not to sign; the request ends, and the trail says who recorded it
        // (JD-S5 R1-S5-10).
        config: {
          readOnly: 'write',
          permission: 'consent.request',
          audits: ['consent.declined'],
        },
        schema: { params: RequestParams, response: { 200: ConsentRequestDto } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.requests.decline(tx, {
            requestId: request.params.id,
            actor: auditActorOf(request, actor),
          }),
        );
      },
    );

    typed.post(
      '/consents/requests/:id/revoke',
      {
        config: {
          // A patient who withdraws a consent is protected in a read-only organization too.
          readOnly: 'patient_protective',
          permission: 'consent.request',
          audits: ['consent.revoked'],
        },
        schema: {
          params: RequestParams,
          body: RevokeConsentRequest,
          response: { 200: ConsentRequestDto },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.revocation.revoke(tx, {
            requestId: request.params.id,
            by: staff(actor),
            auditActor: auditActorOf(request, actor),
            request: request.body,
          }),
        );
      },
    );

    typed.get(
      '/consents/requests/:id',
      {
        config: { readOnly: 'read', permission: 'clinical.consent.read' },
        schema: { params: RequestParams, response: { 200: SignedConsentDto } },
      },
      async (request) => {
        const actor = actorOf(request);
        return withRefusals(deps, request, subject(request), () =>
          deps.withTenant(transactionOf(actor), async (tx) => {
            const record = await openSignedRecord(deps.keys, tx, request.params.id);
            await auditRead(tx, record, { auditActor: auditActorOf(request, actor), via: 'view' });
            return toSignedConsentDto(record, deps.clock());
          }),
        );
      },
    );

    typed.get(
      '/consents/requests/:id/document',
      {
        config: { readOnly: 'read', permission: 'clinical.consent.read' },
        schema: { params: RequestParams },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const document = await withRefusals(deps, request, subject(request), () =>
          deps.withTenant(transactionOf(actor), async (tx) => {
            const record = await openSignedRecord(deps.keys, tx, request.params.id);
            await auditRead(tx, record, {
              auditActor: auditActorOf(request, actor),
              via: 'document',
            });
            return renderSignedDocument(tx, record, deps.clock());
          }),
        );
        // Authenticated and audited; the printable record is sent as it is, never cached or sniffed.
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="${document.fileName}"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
          .send(document.bytes);
      },
    );

    typed.get(
      '/appointments/:id/consent-status',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { params: AppointmentParams, response: { 200: AppointmentConsentStatusDto } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.appointments.statusOf(tx, request.params.id),
        );
      },
    );

    typed.get(
      '/consent/appointment-types',
      {
        config: { readOnly: 'read', permission: 'consent.template.manage' },
        schema: { response: { 200: ConsentRequirementsResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) => deps.appointments.requirements(tx));
      },
    );

    typed.put(
      '/consent/appointment-types/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.template.manage',
          audits: ['setting.changed'],
        },
        schema: {
          params: AppointmentTypeParams,
          body: SetConsentRequirementRequest,
          response: { 200: ConsentRequirementDto },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.appointments.setRequirement(tx, {
            actor: auditActorOf(request, actor),
            appointmentTypeId: request.params.id,
            request: request.body,
          }),
        );
      },
    );
  };
}
