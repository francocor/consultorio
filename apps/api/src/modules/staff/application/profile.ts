import type {
  Matricula,
  ProfessionalDto,
  ProfessionalProfileRequest,
  Result,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional, type ProfessionalRow } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused, loadMember } from '../../access/index.js';
import { assertProfessionalSeatAvailable } from '../../subscriptions/index.js';

/** Format check of a registration for a jurisdiction, by the country pack of the organization. */
export type MatriculaRules = (
  country: string,
  jurisdiction: string,
  value: string,
) => Result<Matricula>;

export interface ProfileActor {
  userId: string;
  membershipId: string;
  roles: readonly string[];
}

export interface SaveProfileInput {
  actor: AuditActor & { userId: string };
  actorMembershipId: string;
  actorRoles: readonly string[];
  targetMembershipId: string;
  country: string;
  request: ProfessionalProfileRequest;
}

export interface ProfileService {
  save(tx: Tx, input: SaveProfileInput): Promise<ProfessionalDto>;
  find(
    tx: Tx,
    input: { actorMembershipId: string; actorRoles: readonly string[]; targetMembershipId: string },
  ): Promise<ProfessionalDto>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export function managesStaff(roles: readonly string[]): boolean {
  return roles.includes('owner') || roles.includes('admin');
}

export function toProfessionalDto(row: ProfessionalRow, fullName: string | null): ProfessionalDto {
  const matricula =
    row.matricula !== null && row.matriculaJurisdiction !== null
      ? {
          jurisdiction: row.matriculaJurisdiction,
          number: row.matricula,
          status:
            row.matriculaStatus === 'verified' ? ('verified' as const) : ('unverified' as const),
        }
      : null;
  return {
    id: row.id,
    membershipId: row.membershipId,
    fullName,
    status: row.status === 'active' ? 'active' : 'inactive',
    specialties: row.specialties,
    matricula,
    maxSimultaneous: row.maxSimultaneous,
    clinicalAccess: row.status === 'active' && matricula !== null,
  };
}

export function createProfileService(deps: { rules: MatriculaRules }): ProfileService {
  return {
    async save(tx, input) {
      const self = input.actorMembershipId === input.targetMembershipId;
      const manager = managesStaff(input.actorRoles);

      const target = await loadMember(tx, input.targetMembershipId);
      if (!target) throw new AppError('not_found');
      // Nobody but the person and those who manage staff touch a profile. Said before anything
      // about the target is revealed.
      if (!self && !manager) throw new AccessRefused('profile_not_self');
      if (target.status !== 'active' || !target.roles.includes('professional')) {
        throw new AppError('conflict');
      }
      if (input.request.maxSimultaneous !== undefined && !manager) {
        throw new AccessRefused('profile_max_simultaneous');
      }

      let normalized: Matricula | null = null;
      if (input.request.matricula !== null) {
        const checked = deps.rules(
          input.country,
          input.request.matricula.jurisdiction,
          input.request.matricula.number,
        );
        if (!checked.ok) {
          throw new AppError('validation_failed', [
            { path: 'matricula', i18nKey: checked.error.i18nKey },
          ]);
        }
        normalized = checked.value;
      }

      const [existing] = await tx
        .select()
        .from(professional)
        .where(eq(professional.membershipId, target.id));
      const [named] = await tx
        .select({ name: membership.displayName })
        .from(membership)
        .where(eq(membership.id, target.id));

      const values = {
        specialties: input.request.specialties,
        matricula: normalized?.number ?? null,
        matriculaJurisdiction: normalized?.jurisdiction ?? null,
        ...(input.request.maxSimultaneous === undefined
          ? {}
          : { maxSimultaneous: input.request.maxSimultaneous }),
      };

      let row: ProfessionalRow | undefined;
      try {
        if (existing) {
          [row] = await tx
            .update(professional)
            .set(values)
            .where(eq(professional.id, existing.id))
            .returning();
        } else {
          // The first profile makes a member an active professional: it takes a seat of the plan.
          await assertProfessionalSeatAvailable(tx);
          [row] = await tx
            .insert(professional)
            .values({
              ...values,
              tenantId: sql`current_setting('app.tenant_id')::uuid`,
              membershipId: target.id,
            })
            .returning();
        }
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) {
          throw new AppError('conflict', [
            { path: 'matricula', i18nKey: 'staff.matricula.duplicate' },
          ]);
        }
        throw error;
      }
      if (!row) throw new Error('professional upsert returned no row');

      if (named?.name !== input.request.fullName) {
        await tx
          .update(membership)
          .set({ displayName: input.request.fullName })
          .where(eq(membership.id, target.id));
      }

      const fields: string[] = [];
      if (named?.name !== input.request.fullName) fields.push('fullName');
      if (existing?.specialties.join('\u0000') !== values.specialties.join('\u0000')) {
        fields.push('specialties');
      }
      const registrationChanged =
        existing?.matricula !== values.matricula ||
        existing.matriculaJurisdiction !== values.matriculaJurisdiction;
      if (registrationChanged) fields.push('matricula');
      if (
        values.maxSimultaneous !== undefined &&
        values.maxSimultaneous !== existing?.maxSimultaneous
      ) {
        fields.push('maxSimultaneous');
      }
      // The database put a verified registration back to unverified; say so in the trail.
      const matriculaReset =
        existing?.matriculaStatus === 'verified' && row.matriculaStatus !== 'verified';

      await audit(tx, {
        action: 'staff.profile_updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'professional',
        resourceId: row.id,
        metadata: { fields, matriculaReset, created: existing === undefined },
      });
      return toProfessionalDto(row, input.request.fullName);
    },

    async find(tx, input) {
      const self = input.actorMembershipId === input.targetMembershipId;
      if (!self && !managesStaff(input.actorRoles)) throw new AccessRefused('profile_not_self');
      const [row] = await tx
        .select()
        .from(professional)
        .where(eq(professional.membershipId, input.targetMembershipId));
      if (!row) throw new AppError('not_found');
      const [named] = await tx
        .select({ name: membership.displayName })
        .from(membership)
        .where(eq(membership.id, input.targetMembershipId));
      return toProfessionalDto(row, named?.name ?? null);
    },
  };
}
