import { randomBytes, randomUUID } from 'node:crypto';

import type {
  PatientPortalResponse,
  PortalIdentityDto,
  PrescriptionProvider,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import { createLocalBotChallenge } from '../../src/adapters/bot-challenge-local/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import type { patient } from '../../src/db/schema/patients.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import { createPortalWiring, type PortalPorts } from '../../src/main/wiring/portal.js';
import {
  createPortalCodeSendJob,
  createPortalNoticeJob,
  createPortalNoticeSweepJob,
} from '../../src/modules/portal/index.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';

import {
  createBookingWorld,
  testAdapters,
  type BookingWorld,
  type Visitor,
} from './booking-world.js';
import { runPending } from './jobs.js';
import { createTestPatient } from './patients.js';
import type { TestSession } from './session.js';

/**
 * The world of the portal tests: the organization of the booking tests (owner, admin, reception,
 * two professionals, public visitors with their cookies, the fake email and the recording job
 * client) plus the portal's own helpers. The application is the one `main` builds, with the portal
 * wired the way production wires it.
 */
export interface PortalWorld extends BookingWorld {
  /** A patient of the organization, written straight to the database. */
  patientWith(values?: Partial<typeof patient.$inferInsert>): Promise<string>;
  /** Staff invite a patient (default: reception). */
  invite(
    patientId: string,
    body?: Record<string, unknown>,
    by?: TestSession,
  ): Promise<LightMyRequestResponse>;
  /** Invites and expects 201. */
  inviteOk(
    patientId: string,
    body?: Record<string, unknown>,
    by?: TestSession,
  ): Promise<PortalIdentityDto>;
  /** The pass that tells the address a record had that its e-mail or birth date changed (every minute in production). */
  sweepNotices(): Promise<void>;
  /** The path of the link in the last email sent to `address` (`/public/t/<token>`). */
  activationPathSentTo(address: string): string;
  /** Follows an activation link as a visitor: shows the page, then presses its button. */
  activate(
    path: string,
    visitor?: Visitor,
  ): Promise<{ page: LightMyRequestResponse; done: LightMyRequestResponse }>;
  /** Invites, follows the link and returns the active identity. */
  onboard(patientId: string, body?: Record<string, unknown>): Promise<PortalIdentityDto>;
  /** What the staff screen of a patient shows. */
  portalOf(patientId: string, by?: TestSession): Promise<PatientPortalResponse>;
  /** The object storage of the application: the files of the documents live here. */
  storage: MemoryObjectStorage;
  /**
   * A document of the patient that passed its scan and is available, with its file in storage. A
   * clinical one is written by the first professional, who is its author. Not shared with anybody.
   */
  documentFor(
    patientId: string,
    options?: {
      clinical?: boolean;
      name?: string;
      bytes?: Buffer;
      category?: string;
      status?: 'available' | 'quarantined';
    },
  ): Promise<{ id: string; objectKey: string; bytes: Buffer }>;
  /** Signs an address with an active account in, on a browser of its own. */
  signInAs(email: string): Promise<Visitor>;
  /**
   * A patient with an active portal account, signed in on a browser of their own. With `email` of
   * its own, so a test can sign the same account in again.
   */
  patientSession(options?: {
    email?: string;
    patient?: Partial<typeof patient.$inferInsert>;
  }): Promise<{ visitor: Visitor; email: string; patientId: string; identity: PortalIdentityDto }>;
}

let patients = 0;

export async function createPortalWorld(
  runtime: Parameters<typeof createBookingWorld>[0],
  options: {
    slug: string;
    now?: Date;
    /** The doors of the consent and prescription modules (fakes, until the integrator wires them). */
    ports?: PortalPorts;
    /**
     * Serves the organization's e-prescription with this provider (the in-memory fake), so the
     * prescriptions module issues for real. Without it the organization has no provider.
     */
    erx?: PrescriptionProvider;
  },
): Promise<PortalWorld> {
  const storage = createMemoryObjectStorage();
  const { ports, erx, ...worldOptions } = options;
  const challenge = createLocalBotChallenge({ secret: randomBytes(32), difficulty: 6 });
  const served = testAdapters(challenge);
  const base = await createBookingWorld(runtime, {
    ...worldOptions,
    app: {
      storage,
      ...(erx
        ? {
            adapters: {
              forTenant: (tenant, port) =>
                (port === 'prescriptionProvider' ? erx : served.forTenant(tenant, port)) as never,
            },
          }
        : {}),
      // The modules wired as `main` wires them, with the portal's doors replaced when a test asks.
      wiring: MODULE_WIRINGS.map((wiring) =>
        wiring.name === 'portal' && ports !== undefined ? createPortalWiring(ports) : wiring,
      ),
    },
  });
  const jobDefinitions = [
    ...base.jobDefinitions,
    createPortalCodeSendJob({ email: base.email, clock: () => base.now() }),
    createPortalNoticeJob({ email: base.email }),
    createPortalNoticeSweepJob({
      email: base.email,
      withTenant: createWithTenant(runtime.db),
      clock: () => base.now(),
    }),
  ];
  const patientWith: PortalWorld['patientWith'] = (values = {}) => {
    patients += 1;
    return createTestPatient(runtime, base.tenant.id, {
      familyName: `Portal${String(patients)}`,
      givenNames: 'Paciente',
      nationalIdType: 'dni',
      nationalId: String(40_000_000 + patients),
      birthDate: '1985-03-10',
      email: `paciente${String(patients)}-${randomUUID().slice(0, 6)}@example.test`,
      ...values,
    });
  };

  // Reception invites the patient; a representative for a minor is invited by an administrator unless a
  // test says otherwise: a record without an e-mail has nobody to tell, and that is for them (R2-2).
  const invite: PortalWorld['invite'] = (
    patientId,
    body = {},
    by = body['email'] === undefined ? base.reception : base.admin,
  ) => base.api.post(`/patients/${patientId}/portal-invitation`, by, body);

  const inviteOk: PortalWorld['inviteOk'] = async (patientId, body, by) => {
    const response = await invite(patientId, body, by);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ identity: PortalIdentityDto }>().identity;
  };

  const activationPathSentTo: PortalWorld['activationPathSentTo'] = (address) => {
    const link = base.email.linkIn(base.email.lastTo(address));
    if (!link) throw new Error(`no link was sent to ${address}`);
    return new URL(link).pathname;
  };

  const activate: PortalWorld['activate'] = async (path, who = base.visitor()) => {
    const page = await who.get(path);
    const done = await who.post(path, {});
    return { page, done };
  };

  const onboard: PortalWorld['onboard'] = async (patientId, body) => {
    const identity = await inviteOk(patientId, body);
    const { done } = await activate(activationPathSentTo(identity.email));
    expect(done.statusCode, done.body).toBe(200);
    const shown = await base.api.get(`/patients/${patientId}/portal`, base.reception);
    const found = shown
      .json<PatientPortalResponse>()
      .identities.find((candidate) => candidate.id === identity.id);
    if (!found) throw new Error('the activated identity is not listed');
    return found;
  };
  const signIn = (email: string) => world.signInAs(email);

  const world: PortalWorld = {
    ...base,
    jobDefinitions,
    runJobs: () => runPending(runtime.db, base.jobs, jobDefinitions),
    sweepNotices: async () => {
      const sweep = jobDefinitions.find((definition) => definition.name === 'portal.notice_sweep');
      if (!sweep) throw new Error('the sweep of notices is not part of the world');
      await runJob(runtime.db, sweep, {
        id: randomUUID(),
        name: sweep.name,
        data: { tenantId: base.tenant.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      });
    },
    storage,
    documentFor: async (patientId, documentOptions = {}) => {
      const id = randomUUID();
      const clinical = documentOptions.clinical === true;
      const status = documentOptions.status ?? 'available';
      const bytes = documentOptions.bytes ?? Buffer.from(`%PDF-1.4 ${id}`);
      const objectKey =
        status === 'available'
          ? `t/${base.tenant.id}/docs/${id}`
          : `t/${base.tenant.id}/quarantine/${id}`;
      await storage.put(base.tenant.id, objectKey, {
        body: bytes,
        contentType: 'application/pdf',
        contentLength: bytes.length,
      });
      const category = documentOptions.category ?? (clinical ? 'lab_result' : 'id_copy');
      await base.inTenant(async (tx) => {
        if (clinical) {
          await tx.execute(
            sql`select set_config('app.professional_id', ${base.doctor.professionalId}, true)`,
          );
        }
        await tx.execute(
          sql`INSERT INTO document
                (id, tenant_id, patient_id, category, classification, original_name,
                 declared_content_type, content_type, size_bytes, status, object_key, sha256,
                 scan_result, upload_completed_at, uploaded_by, author_professional_id)
              VALUES (${id}, ${base.tenant.id}, ${patientId}, ${category},
                      ${clinical ? 'clinical' : 'administrative'},
                      ${documentOptions.name ?? 'documento.pdf'}, 'application/pdf',
                      ${status === 'available' ? 'application/pdf' : null}, ${bytes.length},
                      ${status}, ${objectKey}, ${status === 'available' ? 'a'.repeat(64) : null},
                      ${status === 'available' ? 'clean' : null}, now(), ${randomUUID()},
                      ${clinical ? base.doctor.professionalId : null})`,
        );
      });
      return { id, objectKey, bytes };
    },
    patientWith,
    invite,
    inviteOk,
    activationPathSentTo,
    activate,
    onboard,
    signInAs: async (email) => {
      const visitor = base.visitor();
      const asked = await visitor.post(`/public/${options.slug}/portal/otp`, {
        email,
        challengeProof: await visitor.solve(),
      });
      expect(asked.statusCode, asked.body).toBe(200);
      await runPending(runtime.db, base.jobs, jobDefinitions);
      const done = await visitor.post(`/public/${options.slug}/portal/otp/verify`, {
        email,
        code: base.codeSentTo(email),
      });
      expect(done.statusCode, done.body).toBe(200);
      return visitor;
    },
    patientSession: async (sessionOptions = {}) => {
      const email = sessionOptions.email ?? `p${randomUUID().slice(0, 8)}@example.test`;
      const patientId = await patientWith({ ...sessionOptions.patient, email });
      const identity = await onboard(patientId);
      return { visitor: await signIn(email), email, patientId, identity };
    },
    portalOf: async (patientId, by = base.reception) => {
      const response = await base.api.get(`/patients/${patientId}/portal`, by);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PatientPortalResponse>();
    },
  };
  return world;
}

/** Runs SQL as the organization and returns the rows. */
export async function rowsOf<T extends Record<string, unknown>>(
  world: Pick<BookingWorld, 'inTenant'>,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await world.inTenant((tx) => tx.execute(statement));
  return result.rows as T[];
}
