import {
  ConsentStartersResponse,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  ConsentTemplateListResponse,
  CreateConsentTemplateRequest,
  OfferedConsentTemplatesResponse,
  UpdateConsentTemplateRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { TemplateService } from '../application/templates.js';

import { actorOf, auditActorOf, transactionOf, type ConsentRoutesDeps } from './guard.js';

const TemplateParams = z.strictObject({ id: z.uuid() });

export interface TemplateRoutesDeps extends ConsentRoutesDeps {
  templates: TemplateService;
}

/**
 * The template library (informed-consent, "Consent template authoring" and "Template versioning").
 * Authoring is for who holds `consent.template.manage` (owner, admin, professional); reception is
 * denied with a deny entry by the permission guard. The list of what can be requested from a
 * patient is for who requests consents. None of these screens is linked to a patient.
 */
export function templateRoutes(deps: TemplateRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/consent/templates',
      {
        config: { readOnly: 'read', permission: 'consent.template.manage' },
        schema: { response: { 200: ConsentTemplateListResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) => deps.templates.list(tx));
      },
    );

    typed.get(
      '/consent/starters',
      {
        config: { readOnly: 'read', permission: 'consent.template.manage' },
        schema: { response: { 200: ConsentStartersResponse } },
      },
      () => deps.templates.starters(),
    );

    typed.get(
      '/consent/offered-templates',
      {
        config: { readOnly: 'read', permission: 'consent.request' },
        schema: { response: { 200: OfferedConsentTemplatesResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) => deps.templates.offered(tx));
      },
    );

    typed.get(
      '/consent/templates/:id',
      {
        config: { readOnly: 'read', permission: 'consent.template.manage' },
        schema: { params: TemplateParams, response: { 200: ConsentTemplateDetailResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.templates.detail(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/consent/templates',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.template.manage',
          audits: ['consent.template.created'],
        },
        schema: { body: CreateConsentTemplateRequest, response: { 201: ConsentTemplateDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(transactionOf(actor), (tx) =>
          deps.templates.create(tx, {
            actor: auditActorOf(request, actor),
            request: request.body,
          }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/consent/templates/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.template.manage',
          // A published template is edited by publishing its next version; a draft changes silently.
          audits: ['consent.template.published'],
        },
        schema: {
          params: TemplateParams,
          body: UpdateConsentTemplateRequest,
          response: { 200: ConsentTemplateDetailResponse },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.templates.update(tx, {
            actor: auditActorOf(request, actor),
            templateId: request.params.id,
            request: request.body,
          }),
        );
      },
    );

    typed.post(
      '/consent/templates/:id/publish',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.template.manage',
          audits: ['consent.template.published'],
        },
        schema: { params: TemplateParams, response: { 200: ConsentTemplateDetailResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.templates.publish(tx, {
            actor: auditActorOf(request, actor),
            templateId: request.params.id,
          }),
        );
      },
    );

    typed.post(
      '/consent/templates/:id/retire',
      {
        config: {
          readOnly: 'write',
          permission: 'consent.template.manage',
          audits: ['consent.template.retired'],
        },
        schema: { params: TemplateParams, response: { 200: ConsentTemplateDetailResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.templates.retire(tx, {
            actor: auditActorOf(request, actor),
            templateId: request.params.id,
          }),
        );
      },
    );
  };
}
