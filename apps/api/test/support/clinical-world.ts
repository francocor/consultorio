import { randomUUID } from 'node:crypto';

import type { CreatePatientResponse, NoteDto } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';

import { careAssignment } from '../../src/db/schema/care.js';
import type { DbHandle } from '../../src/platform/db/pool.js';

import { buildTestApplication } from './app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from './session.js';
import { asTenant, createTestTenant, type TestTenant } from './tenants.js';
import { createTestUser } from './users.js';

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

export interface Professional {
  session: TestSession;
  professionalId: string;
}

/**
 * A small organization for the clinical API tests: the roles that must be refused, and a few
 * professionals with real profiles (a matricula), plus helpers to register patients and assign
 * them. Everything goes through the real application, as `app_rw`.
 */
export interface ClinicalWorld {
  app: FastifyInstance;
  api: ReturnType<typeof clientFor>;
  tenant: TestTenant;
  owner: TestSession;
  admin: TestSession;
  reception: TestSession;
  /** Signs in a new professional with a complete profile. */
  professional(specialties?: string[]): Promise<Professional>;
  /** A registered patient, assigned to each of the given professionals (so they are treating). */
  patient(treatedBy?: readonly Professional[]): Promise<string>;
  /** Opens an encounter as `by` and returns the draft. */
  open(by: Professional, patientId: string, body?: Record<string, unknown>): Promise<NoteDto>;
  close(): Promise<void>;
}

// A world signs several people in (Argon2id) and the journeys make many calls: on a busy machine
// (a CI runner shared with other jobs) the default limits are too tight.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let worlds = 0;

export async function createClinicalWorld(
  runtime: DbHandle,
  slug: string,
  overrides: Parameters<typeof buildTestApplication>[1] = {},
): Promise<ClinicalWorld> {
  worlds += 1;
  const tenant = await createTestTenant(runtime, { slug });
  const app = buildTestApplication(runtime, overrides);
  const api = clientFor(app, slug);

  const member = async (roles: RoleName[]) => {
    const user = await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
    return { user, session: await signInAs(app, slug, user) };
  };

  let professionals = 0;
  let patients = 0;
  const owner = (await member(['owner'])).session;
  const admin = (await member(['admin'])).session;
  const reception = (await member(['reception'])).session;

  const world: ClinicalWorld = {
    app,
    api,
    tenant,
    owner,
    admin,
    reception,
    async professional(specialties = ['Medicina general']) {
      professionals += 1;
      const made = await member(['professional']);
      const profile = await api.put(
        `/staff/${made.user.membershipId}/professional-profile`,
        made.session,
        {
          fullName: `Dra. Prueba ${String(worlds)}-${String(professionals)}`,
          specialties,
          matricula: {
            jurisdiction: 'AR-B',
            number: String(700_000 + worlds * 100 + professionals),
          },
        },
      );
      if (profile.statusCode !== 200) throw new Error('could not create the professional profile');
      return { session: made.session, professionalId: profile.json<{ id: string }>().id };
    },
    async patient(treatedBy = []) {
      patients += 1;
      const response = await api.post('/patients', reception, {
        familyName: `Clinica${String(worlds)}x${String(patients)}`,
        givenNames: 'Paciente',
        birthDate: '1980-01-01',
        dataProcessingConsent: true,
      });
      const id = response.json<CreatePatientResponse>().patient.id;
      for (const professional of treatedBy) {
        await asTenant(runtime, tenant.id, (tx) =>
          tx.insert(careAssignment).values({
            tenantId: tenant.id,
            patientId: id,
            professionalId: professional.professionalId,
            assignedBy: randomUUID(),
          }),
        );
      }
      return id;
    },
    async open(by, patientId, body = {}) {
      const response = await api.post('/encounters', by.session, {
        patientId,
        templateKind: 'general',
        ...body,
      });
      if (response.statusCode !== 201) {
        throw new Error(`could not open an encounter: ${String(response.statusCode)}`);
      }
      return response.json<NoteDto>();
    },
    async close() {
      await app.close();
    },
  };
  await app.ready();
  return world;
}
