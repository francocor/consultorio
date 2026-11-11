import { randomUUID } from 'node:crypto';

import type { HoursPeriodDto, SetHoursPeriodRequest } from '@consultorio/contracts';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import { professionalHoursException } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import {
  findHoursProblems,
  formatClock,
  managesStaff,
  parseClock,
  zoneOffsetMinutes,
  type HoursEntry,
} from '../../staff/index.js';

export interface HoursPeriodViewer {
  membershipId: string;
  roles: readonly string[];
}

export interface HoursPeriodService {
  list(tx: Tx, professionalId: string): Promise<HoursPeriodDto[]>;
  set(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      viewer: HoursPeriodViewer;
      professionalId: string;
      request: SetHoursPeriodRequest;
    },
  ): Promise<HoursPeriodDto>;
  remove(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      viewer: HoursPeriodViewer;
      professionalId: string;
      periodId: string;
    },
  ): Promise<void>;
}

async function loadProfessional(tx: Tx, professionalId: string) {
  const [profile] = await tx
    .select({
      id: professional.id,
      membershipId: professional.membershipId,
      status: professional.status,
    })
    .from(professional)
    .where(eq(professional.id, professionalId));
  if (!profile) throw new AppError('not_found');
  return profile;
}

function assertMayEdit(viewer: HoursPeriodViewer, profile: { membershipId: string }): void {
  if (profile.membershipId !== viewer.membershipId && !managesStaff(viewer.roles)) {
    throw new AccessRefused('hours_not_self');
  }
}

export function createHoursPeriodService(deps: { clock?: () => Date } = {}): HoursPeriodService {
  const clock = deps.clock ?? (() => new Date());

  async function live(tx: Tx, professionalId: string): Promise<HoursPeriodDto[]> {
    const rows = await tx
      .select()
      .from(professionalHoursException)
      .where(
        and(
          eq(professionalHoursException.professionalId, professionalId),
          isNull(professionalHoursException.removedAt),
        ),
      )
      .orderBy(
        asc(professionalHoursException.dateFrom),
        asc(professionalHoursException.periodId),
        asc(professionalHoursException.weekday),
        asc(professionalHoursException.startMinute),
        asc(professionalHoursException.id),
      );
    const periods = new Map<string, HoursPeriodDto>();
    for (const row of rows) {
      let period = periods.get(row.periodId);
      if (!period) {
        period = {
          id: row.periodId,
          professionalId: row.professionalId,
          dateFrom: row.dateFrom,
          dateTo: row.dateTo,
          reason: row.reason,
          hours: [],
        };
        periods.set(row.periodId, period);
      }
      if (row.locationId !== null && row.weekday !== null) {
        period.hours.push({
          locationId: row.locationId,
          weekday: row.weekday,
          start: formatClock(row.startMinute ?? 0),
          end: formatClock(row.endMinute ?? 0),
        });
      }
    }
    return [...periods.values()];
  }

  return {
    async list(tx, professionalId) {
      await loadProfessional(tx, professionalId);
      return live(tx, professionalId);
    },

    async set(tx, input) {
      const profile = await loadProfessional(tx, input.professionalId);
      assertMayEdit(input.viewer, profile);
      if (profile.status !== 'active') throw new AppError('conflict');

      const { request } = input;
      const locationIds = [...new Set(request.hours.map((item) => item.locationId))];
      const places =
        locationIds.length === 0
          ? []
          : await tx
              .select({ id: location.id, timeZone: location.timeZone, active: location.active })
              .from(location)
              .where(inArray(location.id, locationIds));
      // A location of another organization does not exist as far as this organization can tell.
      if (places.length !== locationIds.length) throw new AppError('not_found');
      if (places.some((place) => !place.active)) throw new AppError('conflict');

      const entries: HoursEntry[] = request.hours.map((item) => ({
        locationId: item.locationId,
        weekday: item.weekday,
        startMinute: parseClock(item.start),
        endMinute: parseClock(item.end),
      }));
      const now = clock();
      const offsets = new Map(
        places.map((place) => [place.id, zoneOffsetMinutes(place.timeZone, now)]),
      );
      const problems = findHoursProblems(entries, offsets);
      if (problems.length > 0) {
        throw new AppError(
          'validation_failed',
          problems.map(({ path, i18nKey }) => ({ path, i18nKey })),
        );
      }

      // Two live periods of one professional never cover the same date.
      const [clash] = await tx
        .select({ id: professionalHoursException.id })
        .from(professionalHoursException)
        .where(
          and(
            eq(professionalHoursException.professionalId, profile.id),
            isNull(professionalHoursException.removedAt),
            lte(professionalHoursException.dateFrom, request.dateTo),
            gte(professionalHoursException.dateTo, request.dateFrom),
          ),
        )
        .limit(1);
      if (clash) throw new AppError('conflict');

      const periodId = randomUUID();
      const common = {
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        professionalId: profile.id,
        periodId,
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        reason: request.reason ?? null,
        createdBy: input.actor.userId,
      };
      await tx.insert(professionalHoursException).values(
        entries.length === 0
          ? [common]
          : entries.map((entry) => ({
              ...common,
              locationId: entry.locationId,
              weekday: entry.weekday,
              startMinute: entry.startMinute,
              endMinute: entry.endMinute,
            })),
      );
      await audit(tx, {
        action: 'professional.hours_period_set',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'professional',
        resourceId: profile.id,
        metadata: {
          dateFrom: request.dateFrom,
          dateTo: request.dateTo,
          intervals: entries.length,
        },
      });
      const created = (await live(tx, profile.id)).find((period) => period.id === periodId);
      if (!created) throw new Error('hours period was not stored');
      return created;
    },

    async remove(tx, input) {
      const profile = await loadProfessional(tx, input.professionalId);
      assertMayEdit(input.viewer, profile);
      const removed = await tx
        .update(professionalHoursException)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(professionalHoursException.professionalId, profile.id),
            eq(professionalHoursException.periodId, input.periodId),
            isNull(professionalHoursException.removedAt),
          ),
        )
        .returning({ id: professionalHoursException.id });
      if (removed.length === 0) throw new AppError('not_found');
      await audit(tx, {
        action: 'professional.hours_period_removed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'professional',
        resourceId: profile.id,
        metadata: { periodId: input.periodId },
      });
    },
  };
}
