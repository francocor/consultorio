import type { SetWeeklyHoursRequest, WeeklyInterval } from '@consultorio/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { professional, professionalHours } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import {
  findHoursProblems,
  formatClock,
  parseClock,
  zoneOffsetMinutes,
  type HoursEntry,
} from '../domain/hours.js';

import { managesStaff } from './profile.js';

export interface HoursViewer {
  membershipId: string;
  roles: readonly string[];
}

export interface HoursService {
  get(tx: Tx, professionalId: string): Promise<WeeklyInterval[]>;
  set(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      viewer: HoursViewer;
      professionalId: string;
      request: SetWeeklyHoursRequest;
    },
  ): Promise<WeeklyInterval[]>;
}

function toInterval(row: {
  locationId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}): WeeklyInterval {
  return {
    locationId: row.locationId,
    weekday: row.weekday,
    start: formatClock(row.startMinute),
    end: formatClock(row.endMinute),
  };
}

export function createHoursService(deps: { clock?: () => Date } = {}): HoursService {
  const clock = deps.clock ?? (() => new Date());

  async function live(tx: Tx, professionalId: string): Promise<WeeklyInterval[]> {
    const rows = await tx
      .select({
        locationId: professionalHours.locationId,
        weekday: professionalHours.weekday,
        startMinute: professionalHours.startMinute,
        endMinute: professionalHours.endMinute,
      })
      .from(professionalHours)
      .where(
        and(
          eq(professionalHours.professionalId, professionalId),
          isNull(professionalHours.removedAt),
        ),
      )
      .orderBy(
        asc(professionalHours.weekday),
        asc(professionalHours.startMinute),
        asc(professionalHours.id),
      );
    return rows.map(toInterval);
  }

  const key = (interval: WeeklyInterval) =>
    `${interval.locationId}|${String(interval.weekday)}|${interval.start}|${interval.end}`;

  return {
    async get(tx, professionalId) {
      const [profile] = await tx
        .select({ id: professional.id })
        .from(professional)
        .where(eq(professional.id, professionalId));
      if (!profile) throw new AppError('not_found');
      return live(tx, professionalId);
    },

    async set(tx, input) {
      const [profile] = await tx
        .select({
          id: professional.id,
          membershipId: professional.membershipId,
          status: professional.status,
        })
        .from(professional)
        .where(eq(professional.id, input.professionalId));
      if (!profile) throw new AppError('not_found');
      if (profile.membershipId !== input.viewer.membershipId && !managesStaff(input.viewer.roles)) {
        throw new AccessRefused('hours_not_self');
      }
      if (profile.status !== 'active') throw new AppError('conflict');

      const requested = input.request.hours;
      const locationIds = [...new Set(requested.map((item) => item.locationId))];
      const places =
        locationIds.length === 0
          ? []
          : await tx
              .select({ id: location.id, timeZone: location.timeZone, active: location.active })
              .from(location)
              .where(inArray(location.id, locationIds));
      // A location of another organization does not exist as far as this organization can tell.
      if (places.length !== locationIds.length) throw new AppError('not_found');

      const current = await live(tx, profile.id);
      const currentKeys = new Set(current.map(key));
      // An inactive location is hidden from new selections; hours already there may stay.
      const added = requested.filter((item) => !currentKeys.has(key(item)));
      if (
        added.some((item) => places.find((place) => place.id === item.locationId)?.active === false)
      ) {
        throw new AppError('conflict');
      }

      const entries: HoursEntry[] = requested.map((item) => ({
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

      const unchanged =
        current.length === requested.length &&
        requested.every((item) => currentKeys.has(key(item))) &&
        new Set(requested.map(key)).size === requested.length;
      if (unchanged) return current;

      // The old schedule is ended, not erased: what the professional worked is part of the record.
      await tx
        .update(professionalHours)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(professionalHours.professionalId, profile.id),
            isNull(professionalHours.removedAt),
          ),
        );
      if (entries.length > 0) {
        await tx.insert(professionalHours).values(
          entries.map((entry) => ({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            professionalId: profile.id,
            ...entry,
          })),
        );
      }
      await audit(tx, {
        action: 'professional.hours_updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'professional',
        resourceId: profile.id,
        metadata: { intervals: entries.length, locations: locationIds.length },
      });
      return live(tx, profile.id);
    },
  };
}
