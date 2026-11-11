import type { CreateDayOffRequest, DayOffDto, HolidayDto } from '@consultorio/contracts';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { holidayCatalog } from '../../../db/schema/platform-catalogs.js';
import { tenantDayOff } from '../../../db/schema/scheduling-config.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { mergeHolidays } from '../domain/holidays.js';

export interface HolidayService {
  /** The merged calendar of one year: the country catalog plus the organization's days off. */
  holidaysOfYear(tx: Tx, year: number): Promise<HolidayDto[]>;
  /** The merged calendar between two calendar dates, both included. */
  holidaysBetween(tx: Tx, from: string, to: string): Promise<HolidayDto[]>;
  createDayOff(
    tx: Tx,
    input: { actor: AuditActor & { userId: string }; request: CreateDayOffRequest },
  ): Promise<DayOffDto>;
  removeDayOff(
    tx: Tx,
    input: { actor: AuditActor & { userId: string }; id: string },
  ): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function createHolidayService(): HolidayService {
  async function between(tx: Tx, from: string, to: string): Promise<HolidayDto[]> {
    const [org] = await tx.select({ country: tenant.country }).from(tenant);
    const country = org?.country ?? 'AR';
    // `to` is inclusive; the queries are half-open.
    const end = nextDay(to);
    const catalog = await tx
      .select({ date: holidayCatalog.date, name: holidayCatalog.name, kind: holidayCatalog.kind })
      .from(holidayCatalog)
      .where(
        and(
          eq(holidayCatalog.country, country),
          isNull(holidayCatalog.removedAt),
          gte(holidayCatalog.date, from),
          lt(holidayCatalog.date, end),
        ),
      )
      .orderBy(asc(holidayCatalog.date), asc(holidayCatalog.name));
    const daysOff = await tx
      .select({
        id: tenantDayOff.id,
        day: tenantDayOff.day,
        name: tenantDayOff.name,
        locationId: tenantDayOff.locationId,
      })
      .from(tenantDayOff)
      .where(
        and(isNull(tenantDayOff.removedAt), gte(tenantDayOff.day, from), lt(tenantDayOff.day, end)),
      )
      .orderBy(asc(tenantDayOff.day), asc(tenantDayOff.id));
    return mergeHolidays(
      catalog.map((holiday) => ({
        date: holiday.date,
        name: holiday.name,
        kind: holiday.kind === 'bridge' ? ('bridge' as const) : ('national' as const),
      })),
      daysOff,
    );
  }

  return {
    holidaysOfYear: (tx, year) => between(tx, `${String(year)}-01-01`, `${String(year)}-12-31`),
    holidaysBetween: between,

    async createDayOff(tx, input) {
      if (input.request.locationId) {
        const [place] = await tx
          .select({ id: location.id })
          .from(location)
          .where(eq(location.id, input.request.locationId));
        if (!place) throw new AppError('not_found');
      }
      try {
        const [row] = await tx
          .insert(tenantDayOff)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            day: input.request.day,
            name: input.request.name,
            locationId: input.request.locationId ?? null,
            createdBy: input.actor.userId,
          })
          .returning({
            id: tenantDayOff.id,
            day: tenantDayOff.day,
            name: tenantDayOff.name,
            locationId: tenantDayOff.locationId,
          });
        if (!row) throw new Error('day off insert returned no row');
        await audit(tx, {
          action: 'day_off.created',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'day_off',
          resourceId: row.id,
          metadata: { day: row.day },
        });
        return row;
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
    },

    async removeDayOff(tx, input) {
      const removed = await tx
        .update(tenantDayOff)
        .set({ removedAt: new Date(), removedBy: input.actor.userId })
        .where(and(eq(tenantDayOff.id, input.id), isNull(tenantDayOff.removedAt)))
        .returning({ id: tenantDayOff.id, day: tenantDayOff.day });
      const [row] = removed;
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: 'day_off.removed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'day_off',
        resourceId: row.id,
        metadata: { day: row.day },
      });
    },
  };
}
