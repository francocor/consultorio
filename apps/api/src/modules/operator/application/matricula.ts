import {
  MATRICULA_NOTE_MAX,
  type MatriculaNoteRequest,
  type MatriculaUnverifyRequest,
  type MatriculaVerifyRequest,
  type OperatorMatriculaDto,
  type OperatorMatriculaStatus,
} from '@consultorio/contracts';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';

import { matriculaOperatorNote } from '../../../db/schema/operator.js';
import { professional } from '../../../db/schema/staff.js';
import { tenant } from '../../../db/schema/tenant.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import type { OperatorIdentity, OperatorRun } from './context.js';

type Meta = Omit<PlatformAuditActor, 'operatorId'>;

export interface OperatorMatricula {
  /**
   * The registrations that wait for a decision (or, on request, the ones already verified), from
   * every active organization: name, jurisdiction, number and organization, nothing more.
   */
  queue(status: OperatorMatriculaStatus): Promise<OperatorMatriculaDto[]>;
  /**
   * Vouches for the registration the operator checked. Refuses (409) when the organization changed
   * it since, when none is recorded, or when it is already verified.
   */
  verify(
    tenantId: string,
    professionalId: string,
    request: MatriculaVerifyRequest,
    operator: OperatorIdentity,
    meta: Meta,
  ): Promise<OperatorMatriculaDto>;
  /** Withdraws a verification, for example when the authority suspended the registration. */
  unverify(
    tenantId: string,
    professionalId: string,
    request: MatriculaUnverifyRequest,
    operator: OperatorIdentity,
    meta: Meta,
  ): Promise<OperatorMatriculaDto>;
  /** Saves the working note without deciding. An empty text clears it. */
  saveNote(
    tenantId: string,
    professionalId: string,
    request: MatriculaNoteRequest,
    operator: OperatorIdentity,
  ): Promise<OperatorMatriculaDto>;
}

export interface OperatorMatriculaDeps {
  run: OperatorRun;
  clock?: () => Date;
}

/** How many registrations one call returns, so a long list of verified ones stays a short page. */
export const MATRICULA_QUEUE_LIMIT = 200;

interface Row {
  id: string;
  fullName: string | null;
  jurisdiction: string | null;
  number: string | null;
  status: string;
  verifiedAt: Date | null;
  note: string | null;
  profileStatus: string;
  createdAt: Date;
}

interface TenantLabel {
  id: string;
  name: string;
}

/**
 * The columns the operator role may read of a professional (migration 0021), plus the name through
 * the one function that returns it (migration 0505) and the operator's note. The query runs inside
 * a transaction whose tenant is already set, so only that organization's rows exist for it.
 */
function selectRows(tx: Tx) {
  return tx
    .select({
      id: professional.id,
      fullName: sql<string | null>`app.operator_professional_name(${professional.id})`,
      jurisdiction: professional.matriculaJurisdiction,
      number: professional.matricula,
      status: professional.matriculaStatus,
      verifiedAt: professional.verifiedAt,
      note: matriculaOperatorNote.note,
      profileStatus: professional.status,
      createdAt: professional.createdAt,
    })
    .from(professional)
    .leftJoin(
      matriculaOperatorNote,
      and(
        eq(matriculaOperatorNote.targetTenantId, professional.tenantId),
        eq(matriculaOperatorNote.professionalId, professional.id),
      ),
    );
}

function labelOf(row: { id: string; slug: string; theme: Record<string, unknown> }): TenantLabel {
  const name = row.theme['displayName'];
  return {
    id: row.id,
    name: typeof name === 'string' && name.trim() !== '' ? name : row.slug,
  };
}

function toDto(label: TenantLabel, row: Row): OperatorMatriculaDto {
  if (row.jurisdiction === null || row.number === null) {
    throw new Error('a registration without number is not part of the verification');
  }
  return {
    tenant: label,
    professionalId: row.id,
    fullName: row.fullName,
    jurisdiction: row.jurisdiction,
    number: row.number,
    status: row.status === 'verified' ? 'verified' : 'unverified',
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    note: row.note === null || row.note === '' ? null : row.note,
  };
}

/**
 * Matricula verification (staff-professionals, "Matricula uniqueness and validation state"). The
 * platform operator checks a registration with the issuing authority and vouches for it here; only
 * e-prescription reads the result. Everything runs on the operator's database connection, whose
 * role may set the three verification columns of a professional and nothing else: it cannot edit
 * the number, and it has no privilege on any clinical table. The trigger of migration 0013 is what
 * stops every other role from verifying, and it also puts a registration back to unverified when
 * the organization edits the number or the jurisdiction.
 */
export function createOperatorMatricula(deps: OperatorMatriculaDeps): OperatorMatricula {
  const now = deps.clock ?? (() => new Date());

  async function labelFor(tx: Tx, tenantId: string): Promise<TenantLabel> {
    const [found] = await tx
      .select({ id: tenant.id, slug: tenant.slug, theme: tenant.theme })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!found) throw new AppError('not_found');
    return labelOf(found);
  }

  /** The profile as the operator may see it, or not found (another organization's rows do not exist here). */
  async function load(tx: Tx, professionalId: string): Promise<Row> {
    const [row] = await selectRows(tx).where(eq(professional.id, professionalId));
    if (!row) throw new AppError('not_found');
    return row;
  }

  async function writeNote(
    tx: Tx,
    tenantId: string,
    professionalId: string,
    operator: OperatorIdentity,
    note: string,
  ): Promise<void> {
    if (note.length > MATRICULA_NOTE_MAX) throw new AppError('validation_failed');
    await tx
      .insert(matriculaOperatorNote)
      .values({ targetTenantId: tenantId, professionalId, note, updatedBy: operator.id })
      .onConflictDoUpdate({
        target: [matriculaOperatorNote.targetTenantId, matriculaOperatorNote.professionalId],
        set: { note, updatedBy: operator.id, updatedAt: now() },
      });
  }

  /** A registration can be decided only while its profile is active and holds a number. */
  function assertDecidable(row: Row): void {
    if (row.profileStatus !== 'active' || row.number === null || row.jurisdiction === null) {
      throw new AppError('conflict');
    }
  }

  return {
    async queue(status) {
      return deps.run({}, async (tx) => {
        const tenants = await tx
          .select({ id: tenant.id, slug: tenant.slug, theme: tenant.theme })
          .from(tenant)
          .where(ne(tenant.status, 'cancelled'))
          .orderBy(asc(tenant.createdAt), asc(tenant.id));

        const found: { label: TenantLabel; row: Row }[] = [];
        for (const entry of tenants) {
          // Row level security reads the organization from here: one query, one organization.
          await tx.execute(sql`select set_config('app.tenant_id', ${entry.id}, true)`);
          const rows = await selectRows(tx)
            .where(
              and(
                eq(professional.status, 'active'),
                isNotNull(professional.matricula),
                eq(professional.matriculaStatus, status),
              ),
            )
            .orderBy(
              status === 'verified' ? desc(professional.verifiedAt) : asc(professional.createdAt),
            )
            .limit(MATRICULA_QUEUE_LIMIT);
          const label = labelOf(entry);
          for (const row of rows) found.push({ label, row });
        }

        const at = (row: Row) =>
          (status === 'verified' ? row.verifiedAt : row.createdAt)?.getTime() ?? 0;
        found.sort((a, b) =>
          status === 'verified' ? at(b.row) - at(a.row) : at(a.row) - at(b.row),
        );
        return found.slice(0, MATRICULA_QUEUE_LIMIT).map(({ label, row }) => toDto(label, row));
      });
    },

    async verify(tenantId, professionalId, request, operator, meta) {
      return deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const label = await labelFor(tx, tenantId);
        const current = await load(tx, professionalId);
        assertDecidable(current);
        if (current.status === 'verified') throw new AppError('conflict');

        // The registration the operator checked must still be the one the organization holds. The
        // update repeats the comparison, so an edit that lands between the two cannot slip through.
        const verifiedAt = now();
        const updated = await tx
          .update(professional)
          .set({ matriculaStatus: 'verified', verifiedByOperator: operator.id, verifiedAt })
          .where(
            and(
              eq(professional.id, professionalId),
              eq(professional.matriculaStatus, 'unverified'),
              eq(professional.matriculaJurisdiction, request.jurisdiction),
              eq(professional.matricula, request.number),
            ),
          )
          .returning({ id: professional.id });
        if (updated.length === 0) throw new AppError('conflict');

        if (request.note !== undefined) {
          await writeNote(tx, tenantId, professionalId, operator, request.note);
        }
        const metadata = {
          jurisdiction: request.jurisdiction,
          matricula: request.number,
          noteChanged: request.note !== undefined,
        };
        await writePlatformAudit(tx, {
          action: 'operator.matricula.verified',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          targetTenantId: tenantId,
          resourceType: 'professional',
          resourceId: professionalId,
          metadata,
        });
        // The organization's owner sees it in the organization's own trail as well.
        await audit(tx, {
          action: 'matricula.verified',
          outcome: 'allow',
          actor: { ...meta, userId: operator.id, actingRole: null },
          resourceType: 'professional',
          resourceId: professionalId,
          metadata: { ...metadata, operator: operator.displayName },
        });
        return toDto(label, await load(tx, professionalId));
      });
    },

    async unverify(tenantId, professionalId, request, operator, meta) {
      return deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const label = await labelFor(tx, tenantId);
        const current = await load(tx, professionalId);
        assertDecidable(current);
        if (current.status !== 'verified') throw new AppError('conflict');

        const updated = await tx
          .update(professional)
          .set({ matriculaStatus: 'unverified', verifiedByOperator: null, verifiedAt: null })
          .where(
            and(eq(professional.id, professionalId), eq(professional.matriculaStatus, 'verified')),
          )
          .returning({ id: professional.id });
        if (updated.length === 0) throw new AppError('conflict');

        if (request.note !== undefined) {
          await writeNote(tx, tenantId, professionalId, operator, request.note);
        }
        await writePlatformAudit(tx, {
          action: 'operator.matricula.unverified',
          outcome: 'allow',
          actor: { ...meta, operatorId: operator.id },
          targetTenantId: tenantId,
          resourceType: 'professional',
          resourceId: professionalId,
          metadata: {
            jurisdiction: current.jurisdiction,
            matricula: current.number,
            noteChanged: request.note !== undefined,
          },
        });
        return toDto(label, await load(tx, professionalId));
      });
    },

    async saveNote(tenantId, professionalId, request, operator) {
      return deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const label = await labelFor(tx, tenantId);
        const current = await load(tx, professionalId);
        assertDecidable(current);
        await writeNote(tx, tenantId, professionalId, operator, request.note);
        return toDto(label, await load(tx, professionalId));
      });
    },
  };
}
