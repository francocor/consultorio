import type {
  RepresentativeDto,
  RepresentativeInput,
  RepresentativeListResponse,
} from '@consultorio/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { patient, patientRepresentative } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { isMinor, majorityDate } from '../domain/majority.js';

export interface RepresentativeService {
  list(tx: Tx, input: { patientId: string; country: string }): Promise<RepresentativeListResponse>;
  add(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      patientId: string;
      country: string;
      representative: RepresentativeInput;
    },
  ): Promise<RepresentativeDto>;
  end(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      patientId: string;
      representativeId: string;
      country: string;
    },
  ): Promise<void>;
  /** A minor needs at least one live representative. */
  assertCoversMinor(
    tx: Tx,
    input: { patientId: string; birthDate: string; country: string },
  ): Promise<void>;
  /** The birth date changed: the review date of every live representative follows it. */
  recomputeDates(
    tx: Tx,
    input: { patientId: string; birthDate: string; country: string },
  ): Promise<void>;
  isMinor(birthDate: string, country: string): boolean;
  majorityDate(birthDate: string, country: string): string;
}

const REPRESENTATIVE_FIELD = {
  path: 'representative',
  i18nKey: 'patients.minor_needs_representative',
};

export function createRepresentativeService(deps: {
  majorityAge: (country: string) => number;
  clock?: () => Date;
}): RepresentativeService {
  const clock = deps.clock ?? (() => new Date());
  const today = () => clock().toISOString().slice(0, 10);

  async function patientBirthDate(tx: Tx, patientId: string): Promise<string> {
    const [row] = await tx
      .select({ birthDate: patient.birthDate })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
    return row.birthDate;
  }

  async function live(tx: Tx, patientId: string) {
    return tx
      .select()
      .from(patientRepresentative)
      .where(
        and(eq(patientRepresentative.patientId, patientId), isNull(patientRepresentative.endedAt)),
      )
      .orderBy(asc(patientRepresentative.createdAt), asc(patientRepresentative.id));
  }

  function toDto(row: typeof patientRepresentative.$inferSelect): RepresentativeDto {
    return {
      id: row.id,
      fullName: row.fullName,
      relation: row.relation as RepresentativeDto['relation'],
      phone: row.phone,
      email: row.email,
      majorityReviewOn: row.majorityReviewOn,
    };
  }

  return {
    isMinor: (birthDate, country) => isMinor(birthDate, today(), deps.majorityAge(country)),
    majorityDate: (birthDate, country) => majorityDate(birthDate, deps.majorityAge(country)),

    async list(tx, input) {
      const birthDate = await patientBirthDate(tx, input.patientId);
      const rows = await live(tx, input.patientId);
      return {
        minor: isMinor(birthDate, today(), deps.majorityAge(input.country)),
        representatives: rows.map(toDto),
      };
    },

    async add(tx, input) {
      const birthDate = await patientBirthDate(tx, input.patientId);
      const [row] = await tx
        .insert(patientRepresentative)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          patientId: input.patientId,
          fullName: input.representative.fullName,
          relation: input.representative.relation,
          phone: input.representative.phone ?? null,
          email: input.representative.email ?? null,
          majorityReviewOn: majorityDate(birthDate, deps.majorityAge(input.country)),
        })
        .returning();
      if (!row) throw new Error('representative insert returned no row');
      await audit(tx, {
        action: 'patient.representative.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { change: 'added', relation: row.relation },
      });
      return toDto(row);
    },

    async end(tx, input) {
      const birthDate = await patientBirthDate(tx, input.patientId);
      const rows = await live(tx, input.patientId);
      const target = rows.find((row) => row.id === input.representativeId);
      if (!target) throw new AppError('not_found');
      if (rows.length === 1 && isMinor(birthDate, today(), deps.majorityAge(input.country))) {
        throw new AppError('conflict', [REPRESENTATIVE_FIELD]);
      }
      // Ended, not deleted: who was the contact on a given day stays on record.
      await tx
        .update(patientRepresentative)
        .set({ endedAt: new Date() })
        .where(eq(patientRepresentative.id, target.id));
      await audit(tx, {
        action: 'patient.representative.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { change: 'ended', relation: target.relation },
      });
    },

    async assertCoversMinor(tx, input) {
      if (!isMinor(input.birthDate, today(), deps.majorityAge(input.country))) return;
      if ((await live(tx, input.patientId)).length === 0) {
        throw new AppError('validation_failed', [REPRESENTATIVE_FIELD]);
      }
    },

    async recomputeDates(tx, input) {
      await tx
        .update(patientRepresentative)
        .set({ majorityReviewOn: majorityDate(input.birthDate, deps.majorityAge(input.country)) })
        .where(
          and(
            eq(patientRepresentative.patientId, input.patientId),
            isNull(patientRepresentative.endedAt),
          ),
        );
    },
  };
}
