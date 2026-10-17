import type { AddHolidayRequest, OperatorHolidayDto } from '@consultorio/contracts';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { holidayCatalog } from '../../../db/schema/platform-catalogs.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import { AppError } from '../../../platform/http/problem.js';

import type { OperatorIdentity, OperatorRun } from './context.js';

export interface OperatorHolidays {
  list(country: string, year: number): Promise<OperatorHolidayDto[]>;
  /** Adds a holiday, or restores one that was removed (same country, date and name). */
  add(
    request: AddHolidayRequest,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<OperatorHolidayDto>;
  /** Ends a holiday. The row stays, so the catalog keeps its history. */
  remove(
    id: string,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<void>;
}

const columns = {
  id: holidayCatalog.id,
  country: holidayCatalog.country,
  date: holidayCatalog.date,
  name: holidayCatalog.name,
  kind: holidayCatalog.kind,
};

function toDto(row: {
  id: string;
  country: string;
  date: string;
  name: string;
  kind: string;
}): OperatorHolidayDto {
  return { ...row, kind: row.kind === 'bridge' ? 'bridge' : 'national' };
}

/**
 * The country holiday catalog is platform data (country-rules-ar, "Holiday catalog"): the operator
 * adds a bridge day the government declares mid-year and every organization sees it on its next
 * read, with no release. Every change is written to the platform trail in the same transaction.
 */
export function createOperatorHolidays(deps: { run: OperatorRun }): OperatorHolidays {
  return {
    async list(country, year) {
      const rows = await deps.run({}, (tx) =>
        tx
          .select(columns)
          .from(holidayCatalog)
          .where(
            and(
              eq(holidayCatalog.country, country),
              isNull(holidayCatalog.removedAt),
              gte(holidayCatalog.date, `${String(year)}-01-01`),
              lt(holidayCatalog.date, `${String(year + 1)}-01-01`),
            ),
          )
          .orderBy(asc(holidayCatalog.date), asc(holidayCatalog.name)),
      );
      return rows.map(toDto);
    },

    async add(request, operator, meta) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const [row] = await tx
          .insert(holidayCatalog)
          .values({
            country: request.country,
            date: request.date,
            name: request.name,
            kind: request.kind,
          })
          .onConflictDoUpdate({
            target: [holidayCatalog.country, holidayCatalog.date, holidayCatalog.name],
            set: { kind: sql`excluded.kind`, removedAt: null },
          })
          .returning(columns);
        if (!row) throw new Error('holiday upsert returned no row');
        await writePlatformAudit(tx, {
          action: 'holiday.added',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          resourceType: 'holiday',
          resourceId: row.id,
          metadata: { country: row.country, date: row.date, kind: row.kind },
        });
        return toDto(row);
      });
    },

    async remove(id, operator, meta) {
      await deps.run({ operatorId: operator.id }, async (tx) => {
        const [row] = await tx
          .update(holidayCatalog)
          .set({ removedAt: new Date() })
          .where(and(eq(holidayCatalog.id, id), isNull(holidayCatalog.removedAt)))
          .returning(columns);
        if (!row) throw new AppError('not_found');
        await writePlatformAudit(tx, {
          action: 'holiday.removed',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          resourceType: 'holiday',
          resourceId: row.id,
          metadata: { country: row.country, date: row.date },
        });
      });
    },
  };
}
