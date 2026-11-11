import type { ConsentRecordDto, ConsentResponse } from '@consultorio/contracts';
import { asc, eq, sql } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import {
  dataProcessingConsent,
  type DataProcessingConsentRow,
} from '../../../db/schema/privacy.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

type Actor = AuditActor & { userId: string };
export type ConsentStatus = ConsentResponse['status'];

export interface ConsentService {
  /** `granted` while a consent is live, `revoked` after the last one was withdrawn, else `missing`. */
  statusOf(tx: Tx, patientId: string): Promise<ConsentStatus>;
  get(tx: Tx, patientId: string): Promise<ConsentResponse>;
  record(
    tx: Tx,
    input: { actor: Actor; patientId: string; country: string },
  ): Promise<ConsentRecordDto>;
  revoke(tx: Tx, input: { actor: Actor; patientId: string }): Promise<void>;
}

function toDto(row: DataProcessingConsentRow): ConsentRecordDto {
  return {
    id: row.id,
    textKey: row.textKey,
    textVersion: row.textVersion,
    grantedAt: row.grantedAt.toISOString(),
    recordedBy: row.recordedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
  };
}

/**
 * Data-processing consent (patients, "Data-processing consent"; Ley 25.326). The text key and
 * version come from the country pack of the organization, so every consent is tied to the exact
 * text the patient accepted. A revocation ends the record, it does not erase it.
 */
export function createConsentService(deps: {
  textFor: (country: string) => { textKey: string; version: string };
}): ConsentService {
  async function rowsOf(tx: Tx, patientId: string): Promise<DataProcessingConsentRow[]> {
    return tx
      .select()
      .from(dataProcessingConsent)
      .where(eq(dataProcessingConsent.patientId, patientId))
      .orderBy(asc(dataProcessingConsent.grantedAt), asc(dataProcessingConsent.id));
  }

  async function assertPatient(tx: Tx, patientId: string): Promise<void> {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
  }

  function statusFrom(rows: readonly DataProcessingConsentRow[]): ConsentStatus {
    if (rows.some((row) => row.revokedAt === null)) return 'granted';
    return rows.length > 0 ? 'revoked' : 'missing';
  }

  return {
    async statusOf(tx, patientId) {
      return statusFrom(await rowsOf(tx, patientId));
    },

    async get(tx, patientId) {
      await assertPatient(tx, patientId);
      const rows = await rowsOf(tx, patientId);
      const live = rows.find((row) => row.revokedAt === null);
      const current = live ?? rows.at(-1);
      return {
        status: statusFrom(rows),
        current: current ? toDto(current) : null,
        history: rows.map(toDto),
      };
    },

    async record(tx, input) {
      await assertPatient(tx, input.patientId);
      const rows = await rowsOf(tx, input.patientId);
      if (rows.some((row) => row.revokedAt === null)) throw new AppError('conflict');
      const text = deps.textFor(input.country);
      const [row] = await tx
        .insert(dataProcessingConsent)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          patientId: input.patientId,
          textKey: text.textKey,
          textVersion: text.version,
          recordedBy: input.actor.userId,
        })
        .returning();
      if (!row) throw new Error('consent insert returned no row');
      await audit(tx, {
        action: 'patient.consent.recorded',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { textVersion: row.textVersion },
      });
      return toDto(row);
    },

    async revoke(tx, input) {
      await assertPatient(tx, input.patientId);
      const live = (await rowsOf(tx, input.patientId)).find((row) => row.revokedAt === null);
      if (!live) throw new AppError('conflict');
      await tx
        .update(dataProcessingConsent)
        .set({ revokedAt: new Date(), revokedBy: input.actor.userId })
        .where(eq(dataProcessingConsent.id, live.id));
      await audit(tx, {
        action: 'patient.consent.revoked',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { textVersion: live.textVersion },
      });
    },
  };
}

/**
 * Whether messages beyond the service ones (marketing, anything non-essential) may be sent to a
 * patient: only while a consent is live. Appointment reminders and confirmations do not need it
 * (country pack: service messages). Later capabilities ask this before sending.
 */
export async function hasDataProcessingConsent(tx: Tx, patientId: string): Promise<boolean> {
  const rows = await tx
    .select({ revokedAt: dataProcessingConsent.revokedAt })
    .from(dataProcessingConsent)
    .where(eq(dataProcessingConsent.patientId, patientId));
  return rows.some((row) => row.revokedAt === null);
}
