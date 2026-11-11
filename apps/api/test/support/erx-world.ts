import { randomUUID, randomBytes } from 'node:crypto';

import type {
  CreatePatientResponse,
  PrescriptionProvider,
  IssuePrescriptionRequest,
  PrescriptionDto,
  PrescriptionItem,
} from '@consultorio/contracts';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';

import {
  createFakePrescriptionProvider,
  type FakePrescriptionProvider,
} from '../../src/adapters/erx-fake/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { careAssignment } from '../../src/db/schema/care.js';
import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import type { ApplicationOptions } from '../../src/main/application.js';
import { createTenantKeys, type TenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';

import { createClinicalWorld, type ClinicalWorld, type Professional } from './clinical-world.js';
import { createRecordingJobClient, type RecordingJobClient } from './jobs.js';
import type { TestSession } from './session.js';
import { asTenant } from './tenants.js';

export const AMOXICILLIN: PrescriptionItem = {
  genericName: 'Amoxicilina',
  dose: '500 mg',
  form: 'comprimidos',
  quantity: 21,
  instructions: '1 cada 8 horas durante 7 días',
};

export interface ErxWorld extends ClinicalWorld {
  /** The in-memory provider of this world: the test sets its mode and reads what it issued. */
  provider: FakePrescriptionProvider;
  /** What the application enqueued. */
  recorded: RecordingJobClient;
  storage: MemoryObjectStorage;
  /** The key service of the application, so a test can build the jobs the worker would. */
  keys: TenantKeys;
  /** The clock of the application: a test moves it. */
  clock: { now: Date };
  /** A professional whose matricula the platform operator verified. */
  verifiedProfessional(): Promise<Professional>;
  /** Moves the matricula of the professional to verified, the way the operator console does. */
  verify(professional: Professional): Promise<void>;
  /** A patient with a DNI, treated by these professionals. */
  patientWithDocument(treatedBy?: readonly Professional[]): Promise<string>;
  /** Makes this professional treat the patient (an assignment by the owner). */
  treat(patientId: string, professional: Professional): Promise<void>;
  /** Switches e-prescription on for the organization, as the owner. */
  connect(enabled?: boolean): Promise<void>;
  /** Issues a prescription as `by`. */
  issue(
    by: Professional,
    body: Partial<IssuePrescriptionRequest> & { patientId: string },
  ): Promise<LightMyRequestResponse>;
  /** The prescription as the professional reads it. */
  get(by: Professional, id: string): Promise<PrescriptionDto>;
  /** The row of the prescription as the database holds it, read as the system. */
  rowOf(id: string): Promise<Record<string, unknown>>;
  /**
   * Runs `work` with the clock past the pin of a call in flight (JD-S5 R3-3): a call whose outcome
   * is unknown pins the prescription for ten minutes, and nothing acts on it before. The clock goes
   * back when `work` ends.
   */
  pastPin<T>(work: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

/**
 * The clinical world with e-prescription in place: an in-memory provider that belongs to this world
 * alone (so its modes never leak into another test file), an in-memory bucket, a recording queue and
 * the switch of the organization on. One world per test file.
 */
export async function createErxWorld(
  runtime: DbHandle,
  options: {
    slug: string;
    app?: Partial<ApplicationOptions>;
    /** Leave the organization disconnected, to test the state before the owner switches it on. */
    connected?: boolean;
    /** Serve the organization with this provider instead of the in-memory fake (the local simulator). */
    served?: PrescriptionProvider;
  },
): Promise<ErxWorld> {
  const provider = createFakePrescriptionProvider();
  const adapters: AdapterResolver = {
    forTenant: (_tenant, port) =>
      (port === 'prescriptionProvider' ? (options.served ?? provider) : undefined) as never,
  };
  const recorded = createRecordingJobClient();
  const storage = createMemoryObjectStorage();
  const clock = { now: new Date('2026-10-19T15:00:00Z') };
  const keys = createTenantKeys({
    kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
  });
  const world = await createClinicalWorld(runtime, options.slug, {
    adapters,
    jobs: recorded,
    storage,
    keys,
    clock: () => clock.now,
    ...options.app,
  });
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();

  let patients = 0;
  // Unique and deterministic: the counter of the world, on a base taken from the id of its
  // organization. A random part could give two patients of one organization the same document (409).
  const documentBase = 30_000_000 + (Number.parseInt(world.tenant.id.slice(-4), 16) % 1000) * 1000;
  const erx: ErxWorld = {
    ...world,
    provider,
    recorded,
    storage,
    keys,
    clock,
    async verify(professional) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE app_operator');
        await admin.query(`select set_config('app.tenant_id', $1, true)`, [world.tenant.id]);
        await admin.query(
          `update professional set matricula_status = 'verified', verified_by_operator = $1, verified_at = now() where id = $2`,
          [uuidv7(), professional.professionalId],
        );
      } finally {
        await admin.query('COMMIT');
      }
    },
    async verifiedProfessional() {
      const professional = await world.professional();
      await erx.verify(professional);
      return professional;
    },
    async patientWithDocument(treatedBy = []) {
      patients += 1;
      const response = await world.api.post('/patients', world.reception, {
        familyName: `Receta${randomUUID().slice(0, 6)}`,
        givenNames: 'Paula',
        birthDate: '1980-01-01',
        document: {
          type: 'dni',
          number: String(documentBase + patients),
        },
        dataProcessingConsent: true,
      });
      if (response.statusCode !== 201) {
        throw new Error(
          `could not create the patient: ${String(response.statusCode)} ${response.body}`,
        );
      }
      const id = response.json<CreatePatientResponse>().patient.id;
      for (const professional of treatedBy) {
        await asTenant(runtime, world.tenant.id, (tx) =>
          tx.insert(careAssignment).values({
            tenantId: world.tenant.id,
            patientId: id,
            professionalId: professional.professionalId,
            assignedBy: randomUUID(),
          }),
        );
      }
      return id;
    },
    async treat(patientId, professional) {
      const response = await world.api.post(`/patients/${patientId}/assignments`, world.owner, {
        professionalId: professional.professionalId,
      });
      if (response.statusCode >= 300) {
        throw new Error(
          `could not assign the patient: ${String(response.statusCode)} ${response.body}`,
        );
      }
    },
    async connect(enabled = true) {
      const response = await world.api.put('/prescriptions/connection', world.owner, { enabled });
      if (response.statusCode !== 200) {
        throw new Error(
          `could not switch e-prescription: ${String(response.statusCode)} ${response.body}`,
        );
      }
    },
    issue(by, body) {
      return world.api.post('/prescriptions', by.session, {
        clientKey: randomUUID(),
        items: [AMOXICILLIN],
        ...body,
      });
    },
    async get(by, id) {
      const response = await world.api.get(`/prescriptions/${id}`, by.session);
      if (response.statusCode !== 200) {
        throw new Error(`could not read the prescription: ${String(response.statusCode)}`);
      }
      return response.json<PrescriptionDto>();
    },
    async rowOf(id) {
      const { sql } = await import('drizzle-orm');
      const { createWithTenant, SYSTEM_USER_ID } =
        await import('../../src/platform/db/tenant-context.js');
      const result = await createWithTenant(runtime.db)(
        { tenantId: world.tenant.id, userId: SYSTEM_USER_ID },
        (tx) => tx.execute(sql`SELECT * FROM prescription WHERE id = ${id}`),
      );
      const row = result.rows[0];
      if (!row) throw new Error('no such prescription');
      return row;
    },
    async pastPin(work) {
      const before = clock.now;
      clock.now = new Date(before.getTime() + 11 * 60_000);
      try {
        return await work();
      } finally {
        clock.now = before;
      }
    },
    async stop() {
      await admin.end();
      await world.close();
    },
  };
  if (options.connected !== false) await erx.connect();
  return erx;
}

export type { Professional, TestSession };
