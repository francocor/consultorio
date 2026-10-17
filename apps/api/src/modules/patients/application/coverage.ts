import type {
  CoverageDto,
  CoverageInput,
  CoverageListResponse,
  CreatePayerPlanRequest,
  PayerCatalogResponse,
  PayerPlanDto,
  PayerPlanListResponse,
  UpdateCoverageRequest,
} from '@consultorio/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import {
  patientCoverage,
  payerPlan,
  type PatientCoverageRow,
} from '../../../db/schema/coverage.js';
import { patient } from '../../../db/schema/patients.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { assertMayWriteDemographics, type DemographicsEditor } from './write-access.js';

type Actor = AuditActor & { userId: string };

export interface CoverageService {
  catalog(tx: Tx, country: string): Promise<PayerCatalogResponse>;
  listPlans(tx: Tx): Promise<PayerPlanListResponse>;
  createPlan(
    tx: Tx,
    input: { country: string; request: CreatePayerPlanRequest },
  ): Promise<PayerPlanDto>;
  setPlanActive(tx: Tx, input: { planId: string; active: boolean }): Promise<PayerPlanDto>;
  list(tx: Tx, patientId: string): Promise<CoverageListResponse>;
  add(
    tx: Tx,
    input: { actor: Actor; editor: DemographicsEditor; patientId: string; request: CoverageInput },
  ): Promise<CoverageDto>;
  update(
    tx: Tx,
    input: {
      actor: Actor;
      editor: DemographicsEditor;
      patientId: string;
      coverageId: string;
      request: UpdateCoverageRequest;
    },
  ): Promise<CoverageDto>;
  remove(
    tx: Tx,
    input: { actor: Actor; editor: DemographicsEditor; patientId: string; coverageId: string },
  ): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

interface PlanRow {
  id: string;
  payerId: string | null;
  customName: string | null;
  planName: string | null;
  active: boolean;
  payerName: string | null;
  payerKind: string | null;
}

const planColumns = {
  id: payerPlan.id,
  payerId: payerPlan.payerId,
  customName: payerPlan.customName,
  planName: payerPlan.planName,
  active: payerPlan.active,
  payerName: payer.name,
  payerKind: payer.kind,
};

function kindOf(plan: PlanRow): PayerPlanDto['kind'] {
  switch (plan.payerKind) {
    case 'obra_social':
    case 'prepaga':
    case 'private':
      return plan.payerKind;
    default:
      return 'custom';
  }
}

function toPlanDto(plan: PlanRow): PayerPlanDto {
  return {
    id: plan.id,
    payerId: plan.payerId,
    name: plan.payerName ?? plan.customName ?? '',
    kind: kindOf(plan),
    planName: plan.planName,
    active: plan.active,
  };
}

export function createCoverageService(deps: { clock?: () => Date } = {}): CoverageService {
  const clock = deps.clock ?? (() => new Date());
  const today = () => clock().toISOString().slice(0, 10);

  async function findPlan(tx: Tx, planId: string): Promise<PlanRow> {
    const [row] = await tx
      .select(planColumns)
      .from(payerPlan)
      .leftJoin(payer, eq(payer.id, payerPlan.payerId))
      .where(eq(payerPlan.id, planId));
    if (!row) throw new AppError('not_found');
    return row;
  }

  async function assertPatient(tx: Tx, patientId: string): Promise<void> {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
  }

  async function liveRows(tx: Tx, patientId: string): Promise<PatientCoverageRow[]> {
    return tx
      .select()
      .from(patientCoverage)
      .where(and(eq(patientCoverage.patientId, patientId), isNull(patientCoverage.endedAt)))
      .orderBy(asc(patientCoverage.createdAt), asc(patientCoverage.id));
  }

  function isExpired(row: PatientCoverageRow): boolean {
    return row.validTo !== null && row.validTo < today();
  }

  async function toDto(tx: Tx, row: PatientCoverageRow): Promise<CoverageDto> {
    const plan = await findPlan(tx, row.payerPlanId);
    return {
      id: row.id,
      payerPlanId: row.payerPlanId,
      payerName: plan.payerName ?? plan.customName ?? '',
      payerKind: kindOf(plan),
      planName: plan.planName,
      memberNumber: row.memberNumber,
      validFrom: row.validFrom,
      validTo: row.validTo,
      primary: row.isPrimary,
      expired: isExpired(row),
    };
  }

  function assertDates(validFrom: string | null, validTo: string | null): void {
    if (validFrom !== null && validTo !== null && validTo < validFrom) {
      throw new AppError('validation_failed', [
        { path: 'validTo', i18nKey: 'patients.coverage.dates_invalid' },
      ]);
    }
  }

  function assertMemberNumber(plan: PlanRow, memberNumber: string | null): void {
    if (kindOf(plan) !== 'private' && memberNumber === null) {
      throw new AppError('validation_failed', [
        { path: 'memberNumber', i18nKey: 'patients.coverage.member_number_required' },
      ]);
    }
  }

  /** Ends a row and writes its successor: an edit never overwrites the previous values. */
  async function replaceRow(
    tx: Tx,
    row: PatientCoverageRow,
    changes: Partial<typeof patientCoverage.$inferInsert>,
  ): Promise<PatientCoverageRow> {
    await tx
      .update(patientCoverage)
      .set({ endedAt: new Date(), endReason: 'replaced' })
      .where(eq(patientCoverage.id, row.id));
    const [next] = await tx
      .insert(patientCoverage)
      .values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        patientId: row.patientId,
        payerPlanId: row.payerPlanId,
        memberNumber: row.memberNumber,
        validFrom: row.validFrom,
        validTo: row.validTo,
        isPrimary: row.isPrimary,
        ...changes,
      })
      .returning();
    if (!next) throw new Error('coverage insert returned no row');
    return next;
  }

  async function demotePrimary(tx: Tx, patientId: string, exceptId?: string): Promise<void> {
    const rows = await liveRows(tx, patientId);
    for (const row of rows) {
      if (row.isPrimary && row.id !== exceptId) await replaceRow(tx, row, { isPrimary: false });
    }
  }

  return {
    async catalog(tx, country) {
      const rows = await tx
        .select({ id: payer.id, code: payer.code, name: payer.name, kind: payer.kind })
        .from(payer)
        .where(and(eq(payer.country, country), eq(payer.active, true)))
        .orderBy(asc(payer.name));
      return {
        payers: rows.flatMap((row) =>
          row.kind === 'obra_social' || row.kind === 'prepaga' || row.kind === 'private'
            ? [{ ...row, kind: row.kind }]
            : [],
        ),
      };
    },

    async listPlans(tx) {
      const rows = await tx
        .select(planColumns)
        .from(payerPlan)
        .leftJoin(payer, eq(payer.id, payerPlan.payerId))
        .orderBy(asc(payerPlan.createdAt), asc(payerPlan.id));
      return { plans: rows.map(toPlanDto) };
    },

    async createPlan(tx, input) {
      const { request } = input;
      if ('payerId' in request) {
        const [catalogEntry] = await tx
          .select({ id: payer.id })
          .from(payer)
          .where(
            and(
              eq(payer.id, request.payerId),
              eq(payer.country, input.country),
              eq(payer.active, true),
            ),
          );
        if (!catalogEntry) throw new AppError('not_found');
      }
      try {
        const [row] = await tx
          .insert(payerPlan)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            payerId: 'payerId' in request ? request.payerId : null,
            customName: 'customName' in request ? request.customName : null,
            planName: request.planName ?? null,
          })
          .returning({ id: payerPlan.id });
        if (!row) throw new Error('payer plan insert returned no row');
        return toPlanDto(await findPlan(tx, row.id));
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
    },

    async setPlanActive(tx, input) {
      const plan = await findPlan(tx, input.planId);
      if (plan.active !== input.active) {
        await tx.update(payerPlan).set({ active: input.active }).where(eq(payerPlan.id, plan.id));
      }
      return toPlanDto(await findPlan(tx, plan.id));
    },

    async list(tx, patientId) {
      await assertPatient(tx, patientId);
      const rows = await liveRows(tx, patientId);
      const coverages = await Promise.all(rows.map((row) => toDto(tx, row)));
      const preferred = coverages.find((coverage) => coverage.primary && !coverage.expired);
      return { coverages, defaultCoverageId: preferred?.id ?? null };
    },

    async add(tx, input) {
      await assertPatient(tx, input.patientId);
      await assertMayWriteDemographics(tx, input.editor, input.patientId);
      const { request } = input;
      const plan = await findPlan(tx, request.payerPlanId);
      if (!plan.active) throw new AppError('conflict');
      const validFrom = request.validFrom ?? null;
      const validTo = request.validTo ?? null;
      assertDates(validFrom, validTo);
      const memberNumber = request.memberNumber ?? null;
      assertMemberNumber(plan, memberNumber);

      const existing = await liveRows(tx, input.patientId);
      const hasPrimary = existing.some((row) => row.isPrimary);
      // The first coverage is primary on its own; asking for primary demotes the old one.
      const primary = request.primary ?? !hasPrimary;
      if (primary) await demotePrimary(tx, input.patientId);

      const [row] = await tx
        .insert(patientCoverage)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          patientId: input.patientId,
          payerPlanId: plan.id,
          memberNumber,
          validFrom,
          validTo,
          isPrimary: primary,
        })
        .returning();
      if (!row) throw new Error('coverage insert returned no row');
      await audit(tx, {
        action: 'patient.coverage.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { change: 'added', primary },
      });
      return toDto(tx, row);
    },

    async update(tx, input) {
      await assertPatient(tx, input.patientId);
      await assertMayWriteDemographics(tx, input.editor, input.patientId);
      const rows = await liveRows(tx, input.patientId);
      const current = rows.find((row) => row.id === input.coverageId);
      if (!current) throw new AppError('not_found');
      const { request } = input;

      const changes: Partial<typeof patientCoverage.$inferInsert> = {};
      const fields: string[] = [];
      let plan = await findPlan(tx, current.payerPlanId);
      if (request.payerPlanId !== undefined && request.payerPlanId !== current.payerPlanId) {
        plan = await findPlan(tx, request.payerPlanId);
        if (!plan.active) throw new AppError('conflict');
        changes.payerPlanId = plan.id;
        fields.push('payerPlan');
      }
      if (request.memberNumber !== undefined && request.memberNumber !== current.memberNumber) {
        changes.memberNumber = request.memberNumber;
        fields.push('memberNumber');
      }
      if (request.validFrom !== undefined && request.validFrom !== current.validFrom) {
        changes.validFrom = request.validFrom;
        fields.push('validFrom');
      }
      if (request.validTo !== undefined && request.validTo !== current.validTo) {
        changes.validTo = request.validTo;
        fields.push('validTo');
      }
      if (request.primary !== undefined && request.primary !== current.isPrimary) {
        changes.isPrimary = request.primary;
        fields.push('primary');
      }
      if (fields.length === 0) return toDto(tx, current);

      assertDates(changes.validFrom ?? current.validFrom, changes.validTo ?? current.validTo);
      assertMemberNumber(plan, changes.memberNumber ?? current.memberNumber);
      if (changes.isPrimary === true) await demotePrimary(tx, input.patientId, current.id);

      const next = await replaceRow(tx, current, changes);
      await audit(tx, {
        action: 'patient.coverage.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        // Field names only: member numbers are personal data and stay out of the trail.
        metadata: { change: 'updated', fields },
      });
      return toDto(tx, next);
    },

    async remove(tx, input) {
      await assertPatient(tx, input.patientId);
      await assertMayWriteDemographics(tx, input.editor, input.patientId);
      const rows = await liveRows(tx, input.patientId);
      const current = rows.find((row) => row.id === input.coverageId);
      if (!current) throw new AppError('not_found');
      await tx
        .update(patientCoverage)
        .set({ endedAt: new Date(), endReason: 'removed' })
        .where(eq(patientCoverage.id, current.id));
      await audit(tx, {
        action: 'patient.coverage.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { change: 'removed' },
      });
    },
  };
}
