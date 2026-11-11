import {
  AnamnesisContent,
  type AnamnesisResponse,
  type AnamnesisVersionDto,
  type SafetyFlagCode,
} from '@consultorio/contracts';
import { desc, eq, sql } from 'drizzle-orm';

import { anamnesis, type AnamnesisRow } from '../../../db/schema/anamnesis.js';
import { patient } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';

import { applySafetyFlags, computeSafetyFlags } from './safety-flags.js';
import { isTreating } from './write-access.js';

type Actor = AuditActor & { userId: string };

export interface AnamnesisService {
  get(
    tx: Tx,
    input: { actor: Actor; professionalId: string; patientId: string },
  ): Promise<AnamnesisResponse>;
  save(
    tx: Tx,
    input: {
      actor: Actor;
      professionalId: string;
      patientId: string;
      content: AnamnesisContent;
      expectedVersion?: number | undefined;
    },
  ): Promise<AnamnesisVersionDto>;
}

const FIELD = { table: 'anamnesis', column: 'content_enc' } as const;
const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * The anamnesis of a patient (patients, "Anamnesis is clinical data"). Only health professionals
 * reach it, and the database says so too: the clinical policies show zero rows to anyone else. A
 * treating professional reads and writes; a professional who only shares in the organization's
 * sharing scope reads (the read is audited as shared) and never writes.
 *
 * Every save is a new encrypted version, and the safety flag of the patient is recomputed from it
 * in the same transaction.
 */
export function createAnamnesisService(deps: { keys: TenantKeys }): AnamnesisService {
  async function assertPatient(tx: Tx, patientId: string): Promise<{ flags: string[] }> {
    const [row] = await tx
      .select({ flags: patient.safetyFlags })
      .from(patient)
      .where(eq(patient.id, patientId));
    if (!row) throw new AppError('not_found');
    return row;
  }

  async function latest(tx: Tx, patientId: string): Promise<AnamnesisRow | undefined> {
    const [row] = await tx
      .select()
      .from(anamnesis)
      .where(eq(anamnesis.patientId, patientId))
      .orderBy(desc(anamnesis.version))
      .limit(1);
    return row;
  }

  async function open(tx: Tx, row: AnamnesisRow): Promise<AnamnesisVersionDto> {
    const plain = await deps.keys.decryptField(tx, { ...FIELD, rowId: row.id }, row.contentEnc);
    const parsed = AnamnesisContent.safeParse(JSON.parse(plain.toString('utf8')));
    if (!parsed.success) throw new Error('stored anamnesis does not match its schema');
    return {
      version: row.version,
      savedAt: row.createdAt.toISOString(),
      authorProfessionalId: row.authorProfessionalId,
      content: parsed.data,
    };
  }

  return {
    async get(tx, input) {
      await assertPatient(tx, input.patientId);
      const treating = await isTreating(tx, input.professionalId, input.patientId);
      // The policies already hide what this professional may not read. "Nothing is visible" can
      // mean "nothing was recorded" or "you may not see it"; only a treating professional is told
      // the first, everyone else is refused without learning which.
      const row = await latest(tx, input.patientId);
      if (!row && !treating) throw new AccessRefused('anamnesis_not_readable');

      await audit(tx, {
        action: 'clinical.anamnesis.read',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'anamnesis',
        ...(row ? { resourceId: row.id } : {}),
        patientId: input.patientId,
        // Only a read that rests on the sharing scope is marked as shared.
        ...(treating || row?.authorProfessionalId === input.professionalId
          ? {}
          : { reason: 'shared' }),
        metadata: { version: row?.version ?? 0 },
      });
      return { current: row ? await open(tx, row) : null };
    },

    async save(tx, input) {
      const before = await assertPatient(tx, input.patientId);
      // Only a treating professional writes. Shared readers are read-only.
      if (!(await isTreating(tx, input.professionalId, input.patientId))) {
        throw new AccessRefused('anamnesis_not_treating');
      }
      const current = await latest(tx, input.patientId);
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new AppError('stale_revision');
      }

      // The id is chosen first: it is part of what the ciphertext is bound to.
      const id = uuidv7();
      const blob = await deps.keys.encryptField(
        tx,
        { ...FIELD, rowId: id },
        JSON.stringify(input.content),
      );
      let row: AnamnesisRow | undefined;
      try {
        [row] = await tx
          .insert(anamnesis)
          .values({
            id,
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            patientId: input.patientId,
            version: currentVersion + 1,
            authorProfessionalId: input.professionalId,
            contentEnc: blob,
          })
          .returning();
      } catch (error) {
        // Two saves of the same version at once: the second one lost.
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('stale_revision');
        throw error;
      }
      if (!row) throw new Error('anamnesis insert returned no row');

      const flags: SafetyFlagCode[] = computeSafetyFlags(input.content);
      await applySafetyFlags(tx, input.patientId, flags);
      const flagsChanged = flags.join(',') !== [...before.flags].sort().join(',');

      await audit(tx, {
        action: 'clinical.anamnesis.updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'anamnesis',
        resourceId: row.id,
        patientId: input.patientId,
        metadata: { version: row.version, flagsChanged },
      });
      return {
        version: row.version,
        savedAt: row.createdAt.toISOString(),
        authorProfessionalId: row.authorProfessionalId,
        content: input.content,
      };
    },
  };
}
