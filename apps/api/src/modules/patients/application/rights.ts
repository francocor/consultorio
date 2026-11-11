import type {
  CreateRightsRequest,
  FulfillRightsRequest,
  FulfillRightsResponse,
  PatientCopyDto,
  RightsRequestDto,
  RightsRequestListResponse,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import { patientRightsRequest, type PatientRightsRequestRow } from '../../../db/schema/privacy.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import type { ConsentService } from './consent.js';
import type { CoverageService } from './coverage.js';
import type { PatientEditor, PatientService } from './patients.js';
import type { RepresentativeService } from './representatives.js';

type Actor = AuditActor & { userId: string };

export interface RightsService {
  list(tx: Tx, patientId: string): Promise<RightsRequestListResponse>;
  create(
    tx: Tx,
    input: { actor: Actor; patientId: string; request: CreateRightsRequest },
  ): Promise<RightsRequestDto>;
  fulfill(
    tx: Tx,
    input: {
      editor: PatientEditor;
      country: string;
      patientId: string;
      requestId: string;
      request: FulfillRightsRequest;
    },
  ): Promise<FulfillRightsResponse>;
}

function toDto(row: PatientRightsRequestRow): RightsRequestDto {
  return {
    id: row.id,
    kind: row.kind === 'rectification' ? 'rectification' : 'access',
    status: row.status === 'fulfilled' ? 'fulfilled' : 'open',
    requestedAt: row.createdAt.toISOString(),
    requestedBy: row.requestedBy,
    note: row.note,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    fulfilledBy: row.fulfilledBy,
  };
}

/**
 * Access and rectification rights (patients, "Access and rectification rights"; Ley 25.326). Staff
 * log the request and fulfil it. Rectification is never an overwrite: it runs through the
 * versioned update of the patient, so the previous value stays in the history.
 */
export function createRightsService(deps: {
  patients: PatientService;
  coverage: CoverageService;
  consent: ConsentService;
  representatives: RepresentativeService;
  clock?: () => Date;
}): RightsService {
  const clock = deps.clock ?? (() => new Date());

  async function rowsOf(tx: Tx, patientId: string): Promise<PatientRightsRequestRow[]> {
    return tx
      .select()
      .from(patientRightsRequest)
      .where(eq(patientRightsRequest.patientId, patientId))
      .orderBy(asc(patientRightsRequest.createdAt), asc(patientRightsRequest.id));
  }

  async function assertPatient(tx: Tx, patientId: string): Promise<void> {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
  }

  return {
    async list(tx, patientId) {
      await assertPatient(tx, patientId);
      return { requests: (await rowsOf(tx, patientId)).map(toDto) };
    },

    async create(tx, input) {
      await assertPatient(tx, input.patientId);
      const [row] = await tx
        .insert(patientRightsRequest)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          patientId: input.patientId,
          kind: input.request.kind,
          requestedBy: input.actor.userId,
          note:
            input.request.note === undefined || input.request.note === ''
              ? null
              : input.request.note,
        })
        .returning();
      if (!row) throw new Error('rights request insert returned no row');
      await audit(tx, {
        action: 'patient.rights_request.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { kind: row.kind },
      });
      return toDto(row);
    },

    async fulfill(tx, input) {
      await assertPatient(tx, input.patientId);
      const [locked] = await tx
        .select()
        .from(patientRightsRequest)
        .where(
          and(
            eq(patientRightsRequest.id, input.requestId),
            eq(patientRightsRequest.patientId, input.patientId),
          ),
        )
        .for('update');
      if (!locked) throw new AppError('not_found');
      if (locked.status !== 'open') throw new AppError('conflict');

      let copy: PatientCopyDto | null = null;
      if (locked.kind === 'rectification') {
        if (input.request.changes === undefined) {
          throw new AppError('validation_failed', [
            { path: 'changes', i18nKey: 'patients.rights.changes_required' },
          ]);
        }
        // The correction is a normal edit: versioned, audited, and subject to the same write rule.
        await deps.patients.update(tx, {
          editor: input.editor,
          country: input.country,
          id: input.patientId,
          request: input.request.changes,
        });
      } else {
        if (input.request.changes !== undefined) {
          throw new AppError('validation_failed', [
            { path: 'changes', i18nKey: 'patients.rights.changes_not_allowed' },
          ]);
        }
        copy = {
          generatedAt: clock().toISOString(),
          patient: await deps.patients.get(tx, { actor: input.editor.actor, id: input.patientId }),
          coverages: (await deps.coverage.list(tx, input.patientId)).coverages,
          consent: await deps.consent.get(tx, input.patientId),
          representatives: (
            await deps.representatives.list(tx, {
              patientId: input.patientId,
              country: input.country,
            })
          ).representatives,
          history: (await deps.patients.history(tx, input.patientId)).versions,
          rightsRequests: (await rowsOf(tx, input.patientId)).map(toDto),
          clinicalCopy: 'requires_professional',
        };
      }

      const [done] = await tx
        .update(patientRightsRequest)
        .set({
          status: 'fulfilled',
          fulfilledAt: new Date(),
          fulfilledBy: input.editor.actor.userId,
        })
        .where(eq(patientRightsRequest.id, locked.id))
        .returning();
      if (!done) throw new AppError('not_found');
      await audit(tx, {
        action: 'patient.rights_request.fulfilled',
        outcome: 'allow',
        actor: input.editor.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { kind: done.kind },
      });
      // The copy lists the request as it is now.
      if (copy) copy = { ...copy, rightsRequests: (await rowsOf(tx, input.patientId)).map(toDto) };
      return { request: toDto(done), copy };
    },
  };
}
