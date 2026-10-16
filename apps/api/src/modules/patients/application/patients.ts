import type {
  CreatePatientRequest,
  CreatePatientResponse,
  PatientDto,
  PatientHistoryResponse,
  PatientSearchQuery,
  PatientSearchResponse,
  PatientSummaryDto,
  Result,
  UpdatePatientRequest,
} from '@consultorio/contracts';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import { patient, patientVersion, type PatientRow } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';

import { changedFieldsBetween, snapshotOf, toPatientDto, toPatientSummary } from './mapping.js';
import { searchPatients } from './search.js';

/** Validates and normalizes an identity document with the rules of the organization's country. */
export type DocumentRules = (
  country: string,
  type: string,
  value: string,
) => Result<{ type: string; number: string }>;

/** A document that another patient of the organization already holds. */
export class DuplicatePatient extends Error {
  constructor(readonly existing: PatientSummaryDto) {
    super('duplicate patient document');
    this.name = 'DuplicatePatient';
  }
}

export interface PatientEditor {
  actor: AuditActor & { userId: string };
  /** Holds patient administration (role or grant): may edit any patient. */
  canAdminister: boolean;
  /** Set only for a professional with a valid profile. */
  professionalId: string | null;
}

export interface PatientService {
  create(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      country: string;
      request: CreatePatientRequest;
    },
  ): Promise<CreatePatientResponse>;
  get(tx: Tx, input: { actor: AuditActor & { userId: string }; id: string }): Promise<PatientDto>;
  update(
    tx: Tx,
    input: { editor: PatientEditor; country: string; id: string; request: UpdatePatientRequest },
  ): Promise<PatientDto>;
  setStatus(
    tx: Tx,
    input: { actor: AuditActor & { userId: string }; id: string; status: 'active' | 'inactive' },
  ): Promise<PatientDto>;
  history(tx: Tx, id: string): Promise<PatientHistoryResponse>;
  search(tx: Tx, query: PatientSearchQuery): Promise<PatientSearchResponse>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export function createPatientService(deps: {
  documents: DocumentRules;
  clock?: () => Date;
}): PatientService {
  const clock = deps.clock ?? (() => new Date());

  /** Normalizes the document of a request, or fails with the field error of the country pack. */
  function normalizeDocument(
    country: string,
    document: { type: string; number: string },
  ): { type: string; number: string } {
    const checked = deps.documents(country, document.type, document.number);
    if (!checked.ok) {
      throw new AppError('validation_failed', [
        { path: 'document', i18nKey: checked.error.i18nKey },
      ]);
    }
    return checked.value;
  }

  function assertNotFuture(birthDate: string): void {
    if (birthDate > clock().toISOString().slice(0, 10)) {
      throw new AppError('validation_failed', [
        { path: 'birthDate', i18nKey: 'patients.birth_date_future' },
      ]);
    }
  }

  async function holderOf(
    tx: Tx,
    document: { type: string; number: string },
    exceptId?: string,
  ): Promise<PatientRow | undefined> {
    const [row] = await tx
      .select()
      .from(patient)
      .where(
        and(
          eq(patient.nationalIdType, document.type),
          eq(patient.nationalId, document.number),
          exceptId === undefined ? undefined : ne(patient.id, exceptId),
        ),
      );
    return row;
  }

  async function lock(tx: Tx, id: string): Promise<PatientRow> {
    const [row] = await tx.select().from(patient).where(eq(patient.id, id)).for('update');
    if (!row) throw new AppError('not_found');
    return row;
  }

  async function writeVersion(
    tx: Tx,
    row: PatientRow,
    actorUserId: string | null,
    changedFields: string[],
  ): Promise<void> {
    await tx.insert(patientVersion).values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      patientId: row.id,
      version: row.version,
      changedBy: actorUserId,
      changedFields,
      snapshot: snapshotOf(row),
    });
  }

  async function isTreating(tx: Tx, patientId: string, professionalId: string | null) {
    if (professionalId === null) return false;
    const [row] = await tx
      .select({ id: careRelationship.id })
      .from(careRelationship)
      .where(
        and(
          eq(careRelationship.patientId, patientId),
          eq(careRelationship.professionalId, professionalId),
          eq(careRelationship.active, true),
        ),
      );
    return row !== undefined;
  }

  return {
    async create(tx, input) {
      const { request } = input;
      assertNotFuture(request.birthDate);
      const document =
        request.document === undefined || request.document === null
          ? null
          : normalizeDocument(input.country, request.document);
      if (document) {
        const holder = await holderOf(tx, document);
        if (holder) throw new DuplicatePatient(toPatientSummary(holder));
      }

      let row: PatientRow | undefined;
      try {
        [row] = await tx
          .insert(patient)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            familyName: request.familyName,
            givenNames: request.givenNames,
            birthDate: request.birthDate,
            sex: request.sex ?? null,
            nationalIdType: document?.type ?? null,
            nationalId: document?.number ?? null,
            phone: request.phone ?? null,
            email: request.email ?? null,
            address: request.address ?? null,
            emergencyContactName: request.emergencyContact?.name ?? null,
            emergencyContactPhone: request.emergencyContact?.phone ?? null,
            adminNotes: request.adminNotes ?? null,
          })
          .returning();
      } catch (error) {
        // Two registrations of the same document at the same moment: the second one loses.
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
      if (!row) throw new Error('patient insert returned no row');

      await writeVersion(tx, row, input.actor.userId, []);
      await audit(tx, {
        action: 'patient.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: row.id,
        patientId: row.id,
        metadata: { origin: 'staff', hasDocument: document !== null },
      });

      // A warning, never a block: same name and birth date as someone already registered.
      const similar = await tx
        .select()
        .from(patient)
        .where(
          and(
            ne(patient.id, row.id),
            eq(patient.birthDate, row.birthDate),
            eq(patient.searchName, row.searchName),
          ),
        )
        .orderBy(asc(patient.createdAt), asc(patient.id))
        .limit(5);
      return { patient: toPatientDto(row), possibleDuplicates: similar.map(toPatientSummary) };
    },

    async get(tx, input) {
      const [row] = await tx.select().from(patient).where(eq(patient.id, input.id));
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: 'patient.read',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: row.id,
        patientId: row.id,
      });
      return toPatientDto(row);
    },

    async update(tx, input) {
      const row = await lock(tx, input.id);
      const { editor, request } = input;
      // Demographics are organization-wide to READ; to WRITE a professional needs the patient to be
      // theirs (authorization, "Demographics are organization-wide"), unless they administer patients.
      if (!editor.canAdminister && !(await isTreating(tx, row.id, editor.professionalId))) {
        throw new AccessRefused('patient_edit_not_treating');
      }
      if (request.expectedVersion !== undefined && request.expectedVersion !== row.version) {
        throw new AppError('stale_revision');
      }

      const values: Partial<typeof patient.$inferInsert> = {};
      if (request.familyName !== undefined) values.familyName = request.familyName;
      if (request.givenNames !== undefined) values.givenNames = request.givenNames;
      if (request.birthDate !== undefined) {
        assertNotFuture(request.birthDate);
        values.birthDate = request.birthDate;
      }
      if (request.sex !== undefined) values.sex = request.sex;
      if (request.document !== undefined) {
        const document = normalizeDocument(input.country, request.document);
        const holder = await holderOf(tx, document, row.id);
        if (holder) throw new DuplicatePatient(toPatientSummary(holder));
        values.nationalIdType = document.type;
        values.nationalId = document.number;
      }
      if (request.phone !== undefined) values.phone = request.phone === '' ? null : request.phone;
      if (request.email !== undefined) values.email = request.email;
      if (request.address !== undefined)
        values.address = request.address === '' ? null : request.address;
      if (request.emergencyContact !== undefined) {
        values.emergencyContactName = request.emergencyContact?.name ?? null;
        values.emergencyContactPhone = request.emergencyContact?.phone ?? null;
      }
      if (request.adminNotes !== undefined) {
        values.adminNotes = request.adminNotes === '' ? null : request.adminNotes;
      }

      const before = snapshotOf(row);
      const changed = changedFieldsBetween(before, snapshotOf({ ...row, ...values }));
      if (changed.length === 0) return toPatientDto(row);

      let updated: PatientRow | undefined;
      try {
        [updated] = await tx
          .update(patient)
          .set({ ...values, version: row.version + 1 })
          .where(eq(patient.id, row.id))
          .returning();
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
      if (!updated) throw new AppError('not_found');

      await writeVersion(tx, updated, editor.actor.userId, changed);
      await audit(tx, {
        action: 'patient.updated',
        outcome: 'allow',
        actor: editor.actor,
        resourceType: 'patient',
        resourceId: updated.id,
        patientId: updated.id,
        // Field names and the version, never the values.
        metadata: { fields: changed, version: updated.version },
      });
      return toPatientDto(updated);
    },

    async setStatus(tx, input) {
      const row = await lock(tx, input.id);
      if (row.status === input.status) return toPatientDto(row);
      const [updated] = await tx
        .update(patient)
        .set({ status: input.status, version: row.version + 1 })
        .where(eq(patient.id, row.id))
        .returning();
      if (!updated) throw new AppError('not_found');
      await writeVersion(tx, updated, input.actor.userId, ['status']);
      await audit(tx, {
        action: input.status === 'inactive' ? 'patient.deactivated' : 'patient.reactivated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'patient',
        resourceId: updated.id,
        patientId: updated.id,
      });
      return toPatientDto(updated);
    },

    async history(tx, id) {
      const [row] = await tx.select({ id: patient.id }).from(patient).where(eq(patient.id, id));
      if (!row) throw new AppError('not_found');
      const versions = await tx
        .select()
        .from(patientVersion)
        .where(eq(patientVersion.patientId, id))
        .orderBy(asc(patientVersion.version));
      return {
        versions: versions.map((version) => ({
          version: version.version,
          changedAt: version.createdAt.toISOString(),
          changedBy: version.changedBy,
          changedFields: version.changedFields,
          snapshot: version.snapshot,
        })),
      };
    },

    search: (tx, query) => searchPatients(tx, query),
  };
}
