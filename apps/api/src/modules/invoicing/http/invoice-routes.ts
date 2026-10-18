import {
  CreateCreditNoteRequest,
  CreateInvoiceRequest,
  CreateManualInvoiceRequest,
  InvoiceDto,
  InvoiceListQuery,
  InvoiceListResponse,
} from '@consultorio/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { invoice, invoiceLine } from '../../../db/schema/index.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds } from '../../access/index.js';
import type { InvoicingActor } from '../application/common.js';
import { createInvoice, type InvoicingDeps, type Viewer } from '../application/create-invoice.js';
import { createCreditNote } from '../application/credit-note.js';
import { loadInvoice, loadInvoices, scopeCondition, scopeOf } from '../application/invoice-view.js';
import { registerManualInvoice } from '../application/manual-invoice.js';

export interface InvoiceRoutesDeps extends InvoicingDeps {
  withTenant: WithTenant;
}

const IdParams = z.strictObject({ id: z.uuid() });

function actorOf(request: FastifyRequest) {
  const { actor } = request;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/** The actor in the shape the audit writer and the author columns want. */
function invoicingActorOf(request: FastifyRequest): InvoicingActor {
  return { ...request.auditActor, userId: actorOf(request).userId };
}

function viewerOf(request: FastifyRequest): Viewer {
  const actor = actorOf(request);
  return { roles: actor.roles as Viewer['roles'], membershipId: actor.membershipId };
}

/**
 * The invoices of the organization (e-invoicing-afip): asking for one over charge lines (owner,
 * admin and reception), the credit notes (owner and admin), reading them (each viewer sees only the
 * invoices of their locations). An issued invoice is never edited, voided or deleted; the route that
 * refuses to void one exists so the answer is the one the spec asks for: a credit note.
 */
export function invoiceRoutes(deps: InvoiceRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function run<T>(request: FastifyRequest, work: (tx: Tx) => Promise<T>): Promise<T> {
      const actor = actorOf(request);
      return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
    }

    typed.post(
      '/invoices',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.issue',
          audits: ['invoice.requested', 'invoice.retried'],
        },
        schema: { body: CreateInvoiceRequest, response: { 202: InvoiceDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await run(request, (tx) =>
          createInvoice(tx, deps, {
            request: request.body,
            actor: invoicingActorOf(request),
            viewer: viewerOf(request),
            tenantId: actor.tenantId,
          }),
        );
        return reply.code(202).send(created);
      },
    );

    // A voucher issued outside the system (the AFIP web tool): the owner or an admin enters its CAE.
    typed.post(
      '/invoices/manual',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.manual',
          audits: ['invoice.manual', 'invoice.rejected'],
        },
        schema: { body: CreateManualInvoiceRequest, response: { 201: InvoiceDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const saved = await run(request, (tx) =>
          registerManualInvoice(tx, deps, {
            request: request.body,
            actor: invoicingActorOf(request),
            viewer: viewerOf(request),
            tenantId: actor.tenantId,
          }),
        );
        return reply.code(201).send(saved);
      },
    );

    typed.get(
      '/invoices',
      {
        config: { readOnly: 'read', permission: 'invoicing.issue' },
        schema: { querystring: InvoiceListQuery, response: { 200: InvoiceListResponse } },
      },
      (request) => {
        const query = request.query;
        return run(request, async (tx) => {
          const scope = scopeOf(await visibleLocationIds(tx, viewerOf(request)));
          const conditions: (SQL | undefined)[] = [
            scopeCondition(scope),
            query.status ? eq(invoice.status, query.status) : undefined,
            query.kind === 'credit_note'
              ? sql`${invoice.creditNoteOfId} is not null`
              : query.kind === 'invoice'
                ? sql`${invoice.creditNoteOfId} is null`
                : undefined,
            query.patientId ? eq(invoice.patientId, query.patientId) : undefined,
            query.creditNoteOfId ? eq(invoice.creditNoteOfId, query.creditNoteOfId) : undefined,
            query.chargeId
              ? sql`exists (select 1 from ${invoiceLine} where ${invoiceLine.invoiceId} = ${invoice.id} and ${invoiceLine.chargeId} = ${query.chargeId})`
              : undefined,
          ];
          const loaded = await loadInvoices(tx, deps.clock, [and(...conditions)], {
            ...(query.limit ? { limit: query.limit } : {}),
            // The pending ones that waited longest come first.
            order: query.status === 'pending' ? 'oldest' : 'newest',
          });
          const invoices =
            query.prolonged === undefined
              ? loaded.invoices
              : loaded.invoices.filter((entry) => entry.outageFlag === query.prolonged);
          return { invoices, outageThresholdHours: loaded.thresholdHours };
        });
      },
    );

    typed.get(
      '/invoices/:id',
      {
        config: { readOnly: 'read', permission: 'invoicing.issue' },
        schema: { params: IdParams, response: { 200: InvoiceDto } },
      },
      (request) =>
        run(request, async (tx) => {
          const scope = scopeOf(await visibleLocationIds(tx, viewerOf(request)));
          const found = await loadInvoice(tx, deps.clock, request.params.id, scope);
          if (!found) throw new AppError('not_found');
          return found;
        }),
    );

    typed.post(
      '/invoices/:id/credit-notes',
      {
        config: {
          readOnly: 'write',
          permission: 'invoicing.credit_note',
          audits: ['invoice.credit_note'],
        },
        schema: {
          params: IdParams,
          body: CreateCreditNoteRequest,
          response: { 202: InvoiceDto },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await run(request, (tx) =>
          createCreditNote(tx, deps, {
            invoiceId: request.params.id,
            request: request.body,
            actor: invoicingActorOf(request),
            viewer: viewerOf(request),
            tenantId: actor.tenantId,
          }),
        );
        return reply.code(202).send(created);
      },
    );

    // There is no "voided" state: an invoice is corrected with a credit note, never taken back.
    // The route exists to say so to whoever tries (and the database closes the invoice anyway).
    typed.post(
      '/invoices/:id/void',
      {
        config: { readOnly: 'write', permission: 'invoicing.issue', audits: 'none' },
        schema: { params: IdParams },
      },
      () => {
        throw new AppError('invoice_cannot_void');
      },
    );
  };
}
