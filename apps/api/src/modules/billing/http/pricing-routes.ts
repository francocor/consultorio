import {
  CreatePayerPriceRequest,
  CreatePriceRequest,
  CreateTenantPayerRequest,
  PayerListResponse,
  PayerPriceDto,
  PriceDto,
  PriceListResponse,
  PriceQuoteQuery,
  PriceQuoteResponse,
  TenantPayerDto,
  UpdatePayerPriceRequest,
  UpdatePriceRequest,
  UpdateTenantPayerRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { addPayer, listPayers, updatePayer } from '../application/payers.js';
import {
  createPayerPrice,
  createPrice,
  listPrices,
  updatePayerPrice,
  updatePrice,
} from '../application/prices.js';
import { quoteAppointment, selectionOf } from '../application/quote.js';

import { actorOf, billingActorOf, tenantOf } from './context.js';

export interface PricingRoutesDeps {
  withTenant: WithTenant;
  clock: () => Date;
}

const Params = z.strictObject({ id: z.uuid() });

/**
 * The price list and the payers of the organization. Everyone who may see payments reads them (the
 * desk quotes with them); changing them needs `pricing.manage`, which reception does not hold.
 */
export function pricingRoutes(deps: PricingRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/billing/payers',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { response: { 200: PayerListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          listPayers(tx, tenantOf(request).country),
        );
      },
    );

    typed.post(
      '/billing/payers',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: { body: CreateTenantPayerRequest, response: { 201: TenantPayerDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            addPayer(tx, {
              request: request.body,
              country: tenantOf(request).country,
              actor: billingActorOf(request),
            }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/billing/payers/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: {
          params: Params,
          body: UpdateTenantPayerRequest,
          response: { 200: TenantPayerDto },
        },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          updatePayer(tx, {
            id: request.params.id,
            request: request.body,
            country: tenantOf(request).country,
            actor: billingActorOf(request),
            now: deps.clock(),
          }),
        );
      },
    );

    typed.get(
      '/billing/prices',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { response: { 200: PriceListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          listPrices(tx),
        );
      },
    );

    typed.post(
      '/billing/prices',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: { body: CreatePriceRequest, response: { 201: PriceDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => createPrice(tx, { request: request.body, actor: billingActorOf(request) }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/billing/prices/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: { params: Params, body: UpdatePriceRequest, response: { 200: PriceDto } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          updatePrice(tx, {
            id: request.params.id,
            request: request.body,
            actor: billingActorOf(request),
          }),
        );
      },
    );

    // What an appointment would be charged: the same answer the capture stores, without side effects.
    typed.get(
      '/billing/price-quote',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { querystring: PriceQuoteQuery, response: { 200: PriceQuoteResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          quoteAppointment(tx, {
            appointmentId: request.query.appointmentId,
            selection: selectionOf(request.query),
            viewer: actor,
          }),
        );
      },
    );

    typed.post(
      '/billing/payer-prices',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: { body: CreatePayerPriceRequest, response: { 201: PayerPriceDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => createPayerPrice(tx, { request: request.body, actor: billingActorOf(request) }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/billing/payer-prices/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'pricing.manage',
          audits: ['billing.price.changed'],
        },
        schema: { params: Params, body: UpdatePayerPriceRequest, response: { 200: PayerPriceDto } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          updatePayerPrice(tx, {
            id: request.params.id,
            request: request.body,
            actor: billingActorOf(request),
          }),
        );
      },
    );
  };
}
