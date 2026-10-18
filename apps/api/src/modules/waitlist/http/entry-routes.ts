import {
  CloseWaitlistEntryRequest,
  CreateWaitlistEntryRequest,
  SetWaitlistPriorityRequest,
  UpdateWaitlistEntryRequest,
  WaitlistEntryDetailResponse,
  WaitlistCallListResponse,
  WaitlistEntryDto,
  WaitlistListQuery,
  WaitlistListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Actor } from '../../../platform/authz/actor.js';
import { calendarAccess, calendarProfessionalIds } from '../../../platform/authz/calendar-scope.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictWith } from '../../../platform/http/problem.js';
import { visibleLocationIds } from '../../access/index.js';
import { listCalls } from '../application/calls-view.js';
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
  type EntryScope,
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
 * What the member may see of the waitlist: the entries of the places they work at and of the
 * calendars they may work in (a professional's own and the delegated ones). An entry for any place
 * or any professional is everybody's; the others answer "not found" outside the scope, like the
 * rest of the product (judgment day finding B12).
 */
interface Scope extends EntryScope {
  may(entry: { professionalId: string | null; locationId: string | null }): boolean;
}

async function scopeOf(tx: Tx, actor: Actor): Promise<Scope> {
  const visible = await visibleLocationIds(tx, {
    roles: actor.roles,
    membershipId: actor.membershipId,
  });
  return {
    locationIds: visible,
    professionalIds: calendarProfessionalIds(actor),
    may: (entry) =>
      (entry.locationId === null || visible === 'all' || visible.includes(entry.locationId)) &&
      (entry.professionalId === null || calendarAccess(actor, entry.professionalId)),
  };
}

/** The entry, if it is in the scope of the member; "not found" otherwise. */
async function visibleEntry(tx: Tx, actor: Actor, id: string): Promise<WaitlistEntryDto> {
  const entry = await getEntry(tx, id);
  if (!(await scopeOf(tx, actor)).may(entry)) throw new AppError('not_found');
  return entry;
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
        member: Actor,
      ) => Promise<WaitlistEntryDto>,
      status = 200,
    ): Promise<FastifyReply> {
      const actor = actorOf(request);
      const result = await deps.withTenant(
        { tenantId: actor.tenantId, userId: actor.userId },
        async (tx) => {
          try {
            return {
              entry: await work(
                tx,
                { ...request.auditActor, userId: actor.userId },
                deps.clock(),
                actor,
              ),
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
          async (tx, actor, now, member) => {
            // An entry for a place or a calendar outside the member's scope is not theirs to make.
            const scope = await scopeOf(tx, member);
            if (
              !scope.may({
                professionalId: request.body.professionalId ?? null,
                locationId: request.body.locationId ?? null,
              })
            ) {
              throw new AppError('not_found');
            }
            return createEntry(tx, deps.entries, { request: request.body, actor, now });
          },
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
          async (tx) => {
            const scope = await scopeOf(tx, actor);
            return (await listEntries(tx, request.query, scope)).filter((entry) =>
              scope.may(entry),
            );
          },
        );
        return { entries };
      },
    );

    // Registered before `/waitlist/:id`: "to-call" is not an entry id.
    typed.get(
      '/waitlist/to-call',
      {
        config: { readOnly: 'read', permission: 'waitlist.manage' },
        schema: { response: { 200: WaitlistCallListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          const calls = await listCalls(tx, {
            now: deps.clock(),
            viewer: { roles: actor.roles, membershipId: actor.membershipId },
          });
          // The places are already the viewer's; the calendars are checked here.
          const scope = await scopeOf(tx, actor);
          return {
            items: calls.items.filter((item) => scope.may(item.slot)),
            unresponsive: calls.unresponsive.filter((entry) => scope.may(entry)),
          };
        });
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
          entry: await visibleEntry(tx, actor, request.params.id),
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
        await change(request, reply, async (tx, actor, now, member) => {
          const current = await visibleEntry(tx, member, request.params.id);
          // The entry after the edit must still be one the member may have: an edit cannot move it
          // to a place or a calendar outside their scope (judgment day round 2, finding C6).
          const merged = {
            professionalId:
              request.body.professionalId === undefined
                ? current.professionalId
                : request.body.professionalId,
            locationId:
              request.body.locationId === undefined ? current.locationId : request.body.locationId,
          };
          if (!(await scopeOf(tx, member)).may(merged)) throw new AppError('not_found');
          return updateEntry(tx, deps.entries, {
            id: request.params.id,
            request: request.body,
            actor,
            now,
          });
        }),
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
        await change(request, reply, async (tx, actor, now, member) => {
          await visibleEntry(tx, member, request.params.id);
          return pauseEntry(tx, deps.entries, { id: request.params.id, actor, now });
        }),
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
        await change(request, reply, async (tx, actor, now, member) => {
          await visibleEntry(tx, member, request.params.id);
          return resumeEntry(tx, { id: request.params.id, actor, now });
        }),
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
        await change(request, reply, async (tx, actor, now, member) => {
          await visibleEntry(tx, member, request.params.id);
          return closeEntry(tx, deps.entries, {
            id: request.params.id,
            reason: request.body.reason,
            actor,
            now,
          });
        }),
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
        await change(request, reply, async (tx, actor, now, member) => {
          await visibleEntry(tx, member, request.params.id);
          return setPriority(tx, {
            id: request.params.id,
            priority: request.body.priority,
            actor,
            now,
          });
        }),
    );
  };
}
