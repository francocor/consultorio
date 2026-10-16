import type { AssignmentDto, AssignmentListResponse } from '@consultorio/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { careAssignment } from '../../../db/schema/care.js';
import { membership } from '../../../db/schema/identity.js';
import { patient } from '../../../db/schema/patients.js';
import { professional } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';

type Actor = AuditActor & { userId: string };

export interface AssignmentService {
  list(tx: Tx, patientId: string): Promise<AssignmentListResponse>;
  assign(
    tx: Tx,
    input: { actor: Actor; patientId: string; professionalId: string },
  ): Promise<AssignmentDto>;
  remove(tx: Tx, input: { actor: Actor; patientId: string; professionalId: string }): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * Explicit patient assignment (authorization, "Explicit patient assignment"): one of the three
 * sources of the care relationship, available from Stage 1 so a professional can record the
 * anamnesis before any appointment exists. The database keeps `care_relationship` in step through
 * a trigger; removing an assignment ends the relationship only when no appointment or encounter
 * supports it.
 *
 * Nobody assigns a patient to themselves: a professional must not be able to open a record by
 * their own hand, whatever else they hold.
 */
export function createAssignmentService(): AssignmentService {
  async function assertPatient(tx: Tx, patientId: string): Promise<void> {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
  }

  async function profile(tx: Tx, professionalId: string) {
    const [row] = await tx
      .select({
        id: professional.id,
        status: professional.status,
        userId: membership.userId,
        membershipStatus: membership.status,
        name: membership.displayName,
      })
      .from(professional)
      .innerJoin(membership, eq(membership.id, professional.membershipId))
      .where(eq(professional.id, professionalId));
    return row;
  }

  return {
    async list(tx, patientId) {
      await assertPatient(tx, patientId);
      const rows = await tx
        .select({
          professionalId: careAssignment.professionalId,
          assignedBy: careAssignment.assignedBy,
          assignedAt: careAssignment.assignedAt,
          name: membership.displayName,
        })
        .from(careAssignment)
        .innerJoin(professional, eq(professional.id, careAssignment.professionalId))
        .innerJoin(membership, eq(membership.id, professional.membershipId))
        .where(and(eq(careAssignment.patientId, patientId), isNull(careAssignment.removedAt)))
        .orderBy(asc(careAssignment.assignedAt), asc(careAssignment.id));
      return {
        assignments: rows.map((row) => ({
          professionalId: row.professionalId,
          professionalName: row.name,
          assignedBy: row.assignedBy,
          assignedAt: row.assignedAt.toISOString(),
        })),
      };
    },

    async assign(tx, input) {
      await assertPatient(tx, input.patientId);
      const target = await profile(tx, input.professionalId);
      if (!target) throw new AppError('not_found');
      if (target.userId === input.actor.userId) throw new AccessRefused('assignment_self');
      if (target.status !== 'active' || target.membershipStatus !== 'active') {
        throw new AppError('conflict');
      }
      try {
        const [row] = await tx
          .insert(careAssignment)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            patientId: input.patientId,
            professionalId: target.id,
            assignedBy: input.actor.userId,
          })
          .returning();
        if (!row) throw new Error('assignment insert returned no row');
        await audit(tx, {
          action: 'assignment.created',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'patient',
          resourceId: input.patientId,
          patientId: input.patientId,
          metadata: { professionalId: target.id },
        });
        return {
          professionalId: target.id,
          professionalName: target.name,
          assignedBy: row.assignedBy,
          assignedAt: row.assignedAt.toISOString(),
        };
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
    },

    async remove(tx, input) {
      await assertPatient(tx, input.patientId);
      const ended = await tx
        .update(careAssignment)
        .set({ removedAt: new Date(), removedBy: input.actor.userId })
        .where(
          and(
            eq(careAssignment.patientId, input.patientId),
            eq(careAssignment.professionalId, input.professionalId),
            isNull(careAssignment.removedAt),
          ),
        )
        .returning({ id: careAssignment.id });
      if (ended.length === 0) throw new AppError('not_found');
      await audit(tx, {
        action: 'assignment.removed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { professionalId: input.professionalId },
      });
    },
  };
}
