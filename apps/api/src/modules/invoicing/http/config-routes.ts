import {
  CreatePointOfSaleRequest,
  CredentialSummaryDto,
  FiscalConfigResponse,
  FiscalProfileDto,
  InvoicingOptionsDto,
  InvoicingReadinessDto,
  PointOfSaleDto,
  PutCredentialRequest,
  UpdatePointOfSaleRequest,
  UpsertFiscalProfileRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { putCredential } from '../application/credentials.js';
import {
  createPointOfSale,
  getFiscalConfig,
  updatePointOfSale,
  upsertFiscalProfile,
  type FiscalActor,
  type FiscalDeps,
} from '../application/fiscal-config.js';
import { invoicingOptions } from '../application/options.js';
import { invoicingReadiness } from '../application/readiness.js';

export interface ConfigRoutesDeps extends FiscalDeps {
  withTenant: WithTenant;
  keys: TenantKeys;
}

const IdParams = z.strictObject({ id: z.uuid() });

function actorOf(request: FastifyRequest) {
  const { actor } = request;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/**
 * The fiscal configuration of the organization (`invoicing.configure`: owner and admin) and the
 * readiness to issue that reception reads (`invoicing.issue`). Neither the certificate nor the key
 * is ever returned by any of these routes.
 */
export function configRoutes(deps: ConfigRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function run<T>(
      request: FastifyRequest,
      work: (tx: Tx, member: FiscalActor & { tenantId: string }) => Promise<T>,
    ): Promise<T> {
      const actor = actorOf(request);
      return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
        work(tx, { ...request.auditActor, userId: actor.userId, tenantId: actor.tenantId }),
      );
    }

    typed.get(
      '/invoicing/config',
      {
        config: { readOnly: 'read', permission: 'invoicing.configure' },
        schema: { response: { 200: FiscalConfigResponse } },
      },
      (request) => run(request, (tx) => getFiscalConfig(tx, deps)),
    );

    typed.get(
      '/invoicing/readiness',
      {
        config: { readOnly: 'read', permission: 'invoicing.issue' },
        schema: { response: { 200: InvoicingReadinessDto } },
      },
      (request) => run(request, (tx) => invoicingReadiness(tx, deps)),
    );

    // What the form of an invoice needs, for whoever issues invoices (reception included).
    typed.get(
      '/invoicing/options',
      {
        config: { readOnly: 'read', permission: 'invoicing.issue' },
        schema: { response: { 200: InvoicingOptionsDto } },
      },
      (request) => run(request, (tx) => invoicingOptions(tx, deps)),
    );

    typed.put(
      '/invoicing/profile',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.configure',
          audits: ['invoicing.config.changed'],
        },
        schema: { body: UpsertFiscalProfileRequest, response: { 200: FiscalProfileDto } },
      },
      (request) =>
        run(request, (tx, member) =>
          upsertFiscalProfile(tx, deps, {
            actor: member,
            tenantId: member.tenantId,
            request: request.body,
          }),
        ),
    );

    typed.post(
      '/invoicing/points-of-sale',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.configure',
          audits: ['invoicing.config.changed'],
        },
        schema: { body: CreatePointOfSaleRequest, response: { 201: PointOfSaleDto } },
      },
      async (request, reply) => {
        const created = await run(request, (tx, member) =>
          createPointOfSale(tx, deps, {
            actor: member,
            tenantId: member.tenantId,
            request: request.body,
          }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/invoicing/points-of-sale/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.configure',
          audits: ['invoicing.config.changed'],
        },
        schema: {
          params: IdParams,
          body: UpdatePointOfSaleRequest,
          response: { 200: PointOfSaleDto },
        },
      },
      (request) =>
        run(request, (tx, member) =>
          updatePointOfSale(tx, deps, {
            actor: member,
            id: request.params.id,
            request: request.body,
          }),
        ),
    );

    typed.put(
      '/invoicing/credentials',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.configure',
          audits: ['invoicing.credential.changed'],
        },
        schema: { body: PutCredentialRequest, response: { 200: CredentialSummaryDto } },
      },
      (request) =>
        run(request, (tx, member) =>
          putCredential(tx, deps, {
            actor: member,
            tenantId: member.tenantId,
            request: request.body,
          }),
        ),
    );
  };
}
