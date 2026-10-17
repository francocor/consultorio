import {
  CloseWaitlistEntryRequest,
  CreateWaitlistEntryRequest,
  SetWaitlistPriorityRequest,
  UpdateWaitlistEntryRequest,
  WaitlistEntryDetailResponse,
  WaitlistEntryDto,
  WaitlistListQuery,
  WaitlistListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictWith } from '../../../platform/http/problem.js';
import {
  closeEntry,
  createEntry,
  DuplicateEntryError,
  getEntry,
  listEntries,
  pauseEntry,
  resumeEntry,
  setPriority,
  updateEntry,
  type EntryActor,
  type EntryDeps,
} from '../application/entries.js';
import { loadOffers } from '../application/entry-view.js';

export interface EntryRoutesDeps {
  withTenant: WithTenant;
  entries: EntryDeps;
  clock: () => Date;
}

const Params = z.strictObject({ id: z.uuid() });

function actorOf(request: FastifyRequest) {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/**
 * The staff routes of the waitlist: reception, professionals and administrators add patients, edit
 * what they wait for, pause, resume and close their entries. The list is the organization's own
 * (row level security); another organization's entry answers not found.
 */
export function entryRoutes(deps: EntryRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** Runs a change as the signed-in member, turning "the patient already waits" into the 409. */
    async function change(
      request: FastifyRequest,
      reply: FastifyReply,
      work: (
        tx: Tx,
        actor: EntryActor & { userId: string },
        now: Date,
      ) => Promise<WaitlistEntryDto>,
      status = 200,
    ): Promise<FastifyReply> {
      const actor = actorOf(request);
      const result = await deps.withTenant(
        { tenantId: actor.tenantId, userId: actor.userId },
        async (tx) => {
          try {
            return {
              entry: await work(tx, { ...request.auditActor, userId: actor.userId }, deps.clock()),
              existing: undefined,
            };
          } catch (error) {
            // The error is raised before anything is written, so the transaction is still good.
            if (error instanceof DuplicateEntryError) {
              return { entry: undefined, existing: await getEntry(tx, error.existingEntryId) };
            }
            throw error;
          }
        },
      );
      if (result.existing) {
        return conflictWith(request, reply, {
          existingEntryId: result.existing.id,
          existingEntry: result.existing,
        });
      }
      return reply.code(status).send(result.entry);
    }

    typed.post(
      '/waitlist',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.entry.created'],
        },
        schema: { body: CreateWaitlistEntryRequest, response: { 201: WaitlistEntryDto } },
      },
      async (request, reply) =>
        await change(
          request,
          reply,
          (tx, actor, now) => createEntry(tx, deps.entries, { request: request.body, actor, now }),
          201,
        ),
    );

    typed.get(
      '/waitlist',
      {
        config: { readOnly: 'read', permission: 'waitlist.manage' },
        schema: { querystring: WaitlistListQuery, response: { 200: WaitlistListResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        const entries = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => listEntries(tx, request.query),
        );
        return { entries };
      },
    );

    typed.get(
      '/waitlist/:id',
      {
        config: { readOnly: 'read', permission: 'waitlist.manage' },
        schema: { params: Params, response: { 200: WaitlistEntryDetailResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => ({
          entry: await getEntry(tx, request.params.id),
          offers: await loadOffers(tx, request.params.id),
        }));
      },
    );

    typed.patch(
      '/waitlist/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.entry.updated'],
        },
        schema: {
          params: Params,
          body: UpdateWaitlistEntryRequest,
          response: { 200: WaitlistEntryDto },
        },
      },
      async (request, reply) =>
        await change(request, reply, (tx, actor, now) =>
          updateEntry(tx, deps.entries, {
            id: request.params.id,
            request: request.body,
            actor,
            now,
          }),
        ),
    );

    typed.post(
      '/waitlist/:id/pause',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.entry.updated'],
        },
        schema: { params: Params, body: z.strictObject({}), response: { 200: WaitlistEntryDto } },
      },
      async (request, reply) =>
        await change(request, reply, (tx, actor, now) =>
          pauseEntry(tx, { id: request.params.id, actor, now }),
        ),
    );

    typed.post(
      '/waitlist/:id/resume',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.entry.updated'],
        },
        schema: { params: Params, body: z.strictObject({}), response: { 200: WaitlistEntryDto } },
      },
      async (request, reply) =>
        await change(request, reply, (tx, actor, now) =>
          resumeEntry(tx, { id: request.params.id, actor, now }),
        ),
    );

    typed.post(
      '/waitlist/:id/close',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.entry.closed'],
        },
        schema: {
          params: Params,
          body: CloseWaitlistEntryRequest,
          response: { 200: WaitlistEntryDto },
        },
      },
      async (request, reply) =>
        await change(request, reply, (tx, actor, now) =>
          closeEntry(tx, { id: request.params.id, reason: request.body.reason, actor, now }),
        ),
    );

    typed.post(
      '/waitlist/:id/priority',
      {
        config: {
          readOnly: 'write',
          permission: 'waitlist.manage',
          audits: ['waitlist.priority.overridden'],
        },
        schema: {
          params: Params,
          body: SetWaitlistPriorityRequest,
          response: { 200: WaitlistEntryDto },
        },
      },
      async (request, reply) =>
        await change(request, reply, (tx, actor, now) =>
          setPriority(tx, {
            id: request.params.id,
            priority: request.body.priority,
            actor,
            now,
          }),
        ),
    );
  };
}
