import { randomUUID } from 'node:crypto';

import type { BlockDto, BlockListQuery, CreateBlockRequest } from '@consultorio/contracts';
import { and, asc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';

import { scheduleBlock } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { addLocalDays, localParts } from '../domain/time.js';

export interface BlockService {
  list(tx: Tx, query: BlockListQuery): Promise<BlockDto[]>;
  create(
    tx: Tx,
    input: { actor: AuditActor & { userId: string }; request: CreateBlockRequest },
  ): Promise<BlockDto[]>;
  remove(
    tx: Tx,
    input: { actor: AuditActor & { userId: string }; id: string; scope: 'occurrence' | 'series' },
  ): Promise<void>;
}

/** At most this many weekly occurrences in one request (two years of weeks). */
const MAX_OCCURRENCES = 104;

const columns = {
  id: scheduleBlock.id,
  professionalId: scheduleBlock.professionalId,
  locationId: scheduleBlock.locationId,
  startsAt: scheduleBlock.startsAt,
  endsAt: scheduleBlock.endsAt,
  reason: scheduleBlock.reason,
  seriesId: scheduleBlock.seriesId,
};

function toDto(row: {
  id: string;
  professionalId: string | null;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  seriesId: string | null;
}): BlockDto {
  return { ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() };
}

/**
 * The start and end of each occurrence of a weekly block. A block repeats at the same LOCAL time,
 * so it keeps its hour across a daylight saving change (the instants then differ by an hour).
 */
export function weeklyOccurrences(
  zone: string,
  start: Date,
  end: Date,
  recurrence: { count?: number | undefined; until?: string | undefined },
): { startsAt: Date; endsAt: Date }[] {
  const occurrences: { startsAt: Date; endsAt: Date }[] = [];
  for (let week = 0; week < MAX_OCCURRENCES; week += 1) {
    const startsAt = addLocalDays(zone, start, 7 * week);
    if (recurrence.count !== undefined && week >= recurrence.count) break;
    if (recurrence.until !== undefined && localParts(zone, startsAt).date > recurrence.until) break;
    occurrences.push({ startsAt, endsAt: addLocalDays(zone, end, 7 * week) });
  }
  return occurrences;
}

export function createBlockService(): BlockService {
  return {
    async list(tx, query) {
      const conditions = [
        isNull(scheduleBlock.removedAt),
        ...(query.from ? [gt(scheduleBlock.endsAt, new Date(query.from))] : []),
        ...(query.to ? [lt(scheduleBlock.startsAt, new Date(query.to))] : []),
        ...(query.professionalId ? [eq(scheduleBlock.professionalId, query.professionalId)] : []),
        ...(query.locationId ? [eq(scheduleBlock.locationId, query.locationId)] : []),
      ];
      const rows = await tx
        .select(columns)
        .from(scheduleBlock)
        .where(and(...conditions))
        .orderBy(asc(scheduleBlock.startsAt), asc(scheduleBlock.id));
      return rows.map(toDto);
    },

    async create(tx, input) {
      const { request } = input;
      if (request.professionalId) {
        const [found] = await tx
          .select({ id: professional.id })
          .from(professional)
          .where(eq(professional.id, request.professionalId));
        if (!found) throw new AppError('not_found');
      }
      let zone: string | null = null;
      if (request.locationId) {
        const [place] = await tx
          .select({ timeZone: location.timeZone })
          .from(location)
          .where(eq(location.id, request.locationId));
        if (!place) throw new AppError('not_found');
        zone = place.timeZone;
      }

      const start = new Date(request.startsAt);
      const end = new Date(request.endsAt);
      let occurrences = [{ startsAt: start, endsAt: end }];
      let seriesId: string | null = null;
      if (request.recurrence) {
        // The location's zone decides what "same time next week" means.
        if (zone === null) {
          throw new AppError('validation_failed', [
            { path: 'locationId', i18nKey: 'scheduling.block.recurrence_needs_location' },
          ]);
        }
        occurrences = weeklyOccurrences(zone, start, end, request.recurrence);
        seriesId = randomUUID();
      }

      const rows = await tx
        .insert(scheduleBlock)
        .values(
          occurrences.map((occurrence) => ({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            professionalId: request.professionalId ?? null,
            locationId: request.locationId ?? null,
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt,
            reason: request.reason,
            seriesId,
            createdBy: input.actor.userId,
          })),
        )
        .returning(columns);
      rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const [first] = rows;
      if (!first) throw new Error('block insert returned no rows');
      await audit(tx, {
        action: 'schedule_block.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'schedule_block',
        resourceId: first.id,
        metadata: { occurrences: rows.length },
      });
      return rows.map(toDto);
    },

    async remove(tx, input) {
      const [current] = await tx
        .select({ ...columns, removedAt: scheduleBlock.removedAt })
        .from(scheduleBlock)
        .where(eq(scheduleBlock.id, input.id));
      if (!current || current.removedAt !== null) throw new AppError('not_found');

      const now = new Date();
      const scope =
        input.scope === 'series' && current.seriesId !== null
          ? and(
              eq(scheduleBlock.seriesId, current.seriesId),
              gte(scheduleBlock.startsAt, current.startsAt),
              isNull(scheduleBlock.removedAt),
            )
          : eq(scheduleBlock.id, current.id);
      const removed = await tx
        .update(scheduleBlock)
        .set({ removedAt: now, removedBy: input.actor.userId })
        .where(scope)
        .returning({ id: scheduleBlock.id });
      await audit(tx, {
        action: 'schedule_block.removed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'schedule_block',
        resourceId: current.id,
        metadata: { occurrences: removed.length },
      });
    },
  };
}
