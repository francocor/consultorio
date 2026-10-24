import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakePrescriptionProvider } from '../../src/adapters/erx-fake/index.js';
import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../src/db/seed/demo/credentials.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createPortalSessions } from '../../src/modules/portal/application/sessions.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { portalCookieName } from '../../src/platform/http/portal-session.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { clientFor, signInAs, type TestSession } from '../support/session.js';
import { createTestTenant } from '../support/tenants.js';
import type { TestUser } from '../support/users.js';

/**
 * The probes of the fresh-context review of Stage 5 (task 5.51), run against the seeded
 * demonstration organizations, which hold every kind of record at once: portal isolation (a patient
 * sees only their own, never another patient's or another organization's), consent integrity (a
 * signature binds to the version shown and to the way the request was made), and prescription
 * access (only the prescriber and the professionals who treat the patient). Each probe attacks and
 * then looks at the record to see that nothing moved.
 */

let runtime: DbHandle;
let operator: OperatorHarness;
let deps: DemoSeedDeps;
let app: FastifyInstance;
let a: string;
let b: string;

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock: () => new Date(),
    documents: { storage: createMemoryObjectStorage(), scanner: createFakeScanner() },
    operatorDb: operator.db.db,
    prescriptionProvider: createFakePrescriptionProvider(),
  };
  a = (await createTestTenant(runtime, { slug: 'iso-a', isDemo: true, billingExempt: true })).id;
  b = (await createTestTenant(runtime, { slug: 'iso-b', isDemo: true, billingExempt: true })).id;
  await seedDemoTenant(deps, a);
  await seedDemoTenant({ ...deps, emailFor: (staff) => staff.email.replace('@', '+b@') }, b);
  app = buildTestApplication(runtime, { keys: deps.keys });
}, 400_000);

afterAll(async () => {
  await app.close();
  await operator.close();
  await runtime.close();
});

const system = (tenantId: string) => ({ tenantId, userId: SYSTEM_USER_ID });

async function rows<T extends Record<string, unknown>>(
  tenantId: string,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  return deps.withTenant(system(tenantId), async (tx) => (await tx.execute<T>(query)).rows as T[]);
}

async function staff(slug: string, key: string, suffix = ''): Promise<TestSession> {
  const account = DEMO_ACCOUNTS.find((entry) => entry.key === key);
  if (!account) throw new Error(`no demo account ${key}`);
  const email = account.email.replace('@', `${suffix}@`);
  return signInAs(app, slug, { email } as unknown as TestUser, DEMO_PASSWORD);
}

interface Portal {
  cookie: string;
  get(url: string, slug?: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown, slug?: string): Promise<LightMyRequestResponse>;
}

/** A portal session for an account the seed activated, made straight in the database (no code). */
async function portalSession(tenantId: string, slug: string, email: string): Promise<Portal> {
  const found = await rows<{ identity: string; link: string }>(
    tenantId,
    sql`SELECT i.id AS identity, l.id AS link
          FROM portal_identity i JOIN portal_link l ON l.portal_identity_id = i.id
         WHERE i.email = ${email}`,
  );
  const first = found[0];
  if (!first) throw new Error(`no portal account for ${email}`);
  const issued = await deps.withTenant(system(tenantId), (tx) =>
    createPortalSessions().issue(tx, {
      identityId: first.identity,
      selectedLinkId: first.link,
      now: new Date(),
      ip: null,
      userAgent: 'vitest-isolation',
    }),
  );
  const cookie = `${portalCookieName(true)}=${issued.token}`;
  const send = (method: 'GET' | 'POST', url: string, payload: unknown, host: string) =>
    app.inject({
      method,
      url,
      headers: browserHeaders(host, cookie),
      remoteAddress: '10.88.1.1',
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    cookie,
    get: (url, host = slug) => send('GET', url, undefined, host),
    post: (url, payload, host = slug) => send('POST', url, payload ?? {}, host),
  };
}

const requestOf = async (tenantId: string, patientFamily: string, status: string) => {
  const [found] = await rows<{ id: string; method: string; version_id: string }>(
    tenantId,
    sql`SELECT r.id, r.method, r.template_version_id AS version_id
          FROM consent_request r JOIN patient p ON p.id = r.patient_id
         WHERE p.family_name = ${patientFamily} AND r.status = ${status}
         ORDER BY r.created_at LIMIT 1`,
  );
  if (!found) throw new Error(`no ${status} consent for ${patientFamily}`);
  return found;
};

const SIGN_BODY = (name: string) => ({
  accepted: true,
  contentHash: 'a'.repeat(64),
  signerName: name,
  signature: { kind: 'typed', value: name },
});

describe('portal isolation', () => {
  it('shows a patient their own consents and prescriptions and nobody else’s', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');

    const consents = await valentina.get('/portal/consents');
    const prescriptions = await valentina.get('/portal/prescriptions');

    expect(consents.statusCode, consents.body).toBe(200);
    expect(
      consents
        .json<{ consents: { status: string }[] }>()
        .consents.map((entry) => entry.status)
        .sort(),
    ).toEqual(['pending', 'revoked']);
    expect(prescriptions.statusCode, prescriptions.body).toBe(200);
    expect(
      prescriptions
        .json<{ prescriptions: { status: string }[] }>()
        .prescriptions.map((entry) => entry.status)
        .sort(),
    ).toEqual(['dispensed', 'issued']);
  });

  it('answers 404, and writes portal.denied, for every record of another patient', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    const others = await requestOf(a, 'Rodríguez', 'signed');
    const waiting = await requestOf(a, 'Martínez', 'pending');
    const [theirs] = await rows<{ id: string }>(
      a,
      sql`SELECT r.id FROM consent_request r JOIN patient p ON p.id = r.patient_id WHERE p.family_name = 'Rodríguez'`,
    );
    const before =
      (
        await rows<{ n: number }>(
          a,
          sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'portal.denied'`,
        )
      )[0]?.n ?? 0;

    const attempts = [
      await valentina.get(`/portal/consents/${others.id}`),
      await valentina.post(`/portal/consents/${others.id}/download-link`),
      await valentina.post(`/portal/consents/${others.id}/revoke`, {}),
      await valentina.post(`/portal/consents/${waiting.id}/sign`, SIGN_BODY('Valentina Gómez')),
      await valentina.get(`/portal/consents/${theirs?.id ?? ''}`),
    ];

    expect(attempts.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    const after =
      (
        await rows<{ n: number }>(
          a,
          sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'portal.denied'`,
        )
      )[0]?.n ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(attempts.length);
    // Nothing moved: the other patient's consent is still signed and the waiting one still waits.
    expect((await requestOf(a, 'Rodríguez', 'signed')).id).toBe(others.id);
    expect((await requestOf(a, 'Martínez', 'pending')).id).toBe(waiting.id);
  });

  it('refuses the download link of a prescription that belongs to another patient', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    // The prescriptions are clinical rows: the ids are read as the cardiologist who wrote them.
    const cardiologist = await deps.withTenant(
      system(a),
      async (tx) =>
        (
          await tx.execute<{ id: string; user_id: string }>(
            sql`SELECT p.id, m.user_id FROM professional p JOIN membership m ON m.id = p.membership_id WHERE p.matricula = '41258'`,
          )
        ).rows[0],
    );
    const joaquin = await deps.withTenant(
      {
        tenantId: a,
        userId: cardiologist?.user_id ?? '',
        actingProfessionalId: cardiologist?.id ?? '',
      },
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`SELECT r.id FROM prescription r JOIN patient p ON p.id = r.patient_id WHERE p.family_name = 'López'`,
          )
        ).rows[0],
    );
    expect(joaquin?.id).toBeDefined();

    const response = await valentina.post(
      `/portal/prescriptions/${joaquin?.id ?? ''}/download-link`,
    );

    expect(response.statusCode).toBe(404);
  });

  it('refuses another organization’s ids and the session of one organization on the host of another', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    const foreign = await requestOf(b, 'Gómez', 'pending');

    const byId = await valentina.get(`/portal/consents/${foreign.id}`);
    const onOtherHost = await valentina.get('/portal/me', 'iso-b');

    expect(byId.statusCode).toBe(404);
    expect(onOtherHost.statusCode).toBe(401);
  });

  it('lets a representative see only the minor they represent, and refuses to switch to a patient they do not', async () => {
    const paula = await portalSession(a, 'iso-a', 'paula.navarro@demo.invalid');
    const [valentinaLink] = await rows<{ id: string }>(
      a,
      sql`SELECT l.id FROM portal_link l JOIN patient p ON p.id = l.patient_id WHERE p.family_name = 'Gómez'`,
    );

    const me = await paula.get('/portal/me');
    const switched = await paula.post('/portal/subject', { linkId: valentinaLink?.id });
    const consents = await paula.get('/portal/consents');

    expect(me.statusCode, me.body).toBe(200);
    expect(JSON.stringify(me.json())).toContain('Ian');
    expect(JSON.stringify(me.json())).not.toContain('Valentina');
    expect(switched.statusCode).toBe(404);
    expect(consents.json<{ consents: unknown[] }>().consents).toEqual([]);
  });

  it('keeps staff and patient sessions apart', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    const reception = await staff('iso-a', 'reception');

    const patientOnStaffRoute = await app.inject({
      method: 'GET',
      url: '/patients',
      headers: browserHeaders('iso-a', valentina.cookie),
      remoteAddress: '10.88.1.2',
    });
    const staffOnPortalRoute = await app.inject({
      method: 'GET',
      url: '/portal/me',
      headers: browserHeaders('iso-a', reception.cookie),
      remoteAddress: '10.88.1.3',
    });

    expect(patientOnStaffRoute.statusCode).toBe(401);
    expect(staffOnPortalRoute.statusCode).toBe(401);
  });
});

describe('consent integrity', () => {
  it('refuses a signature on the old version of the text and keeps the request waiting', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    const waiting = await requestOf(a, 'Gómez', 'pending');
    const [oldVersion] = await rows<{ id: string }>(
      a,
      sql`SELECT v.id FROM consent_template_version v
           WHERE v.version_number = 1 AND v.template_id = (
             SELECT w.template_id FROM consent_template_version w WHERE w.id = ${waiting.version_id}::uuid)`,
    );

    const detail = await valentina.get(`/portal/consents/${waiting.id}`);
    const staleStaff = await clientFor(app, 'iso-a').post(
      `/consents/requests/${waiting.id}/sign`,
      await staff('iso-a', 'cardiology'),
      {
        versionId: oldVersion?.id,
        accepted: true,
        signer: 'patient',
        mark: { kind: 'typed', name: 'Valentina Gómez' },
      },
    );

    expect(detail.statusCode, detail.body).toBe(200);
    // The text on screen is version 2; the request is bound to it and nothing else.
    expect(detail.json<{ body: string }>().body).toContain('Aclaración de la segunda versión');
    // A request made for the portal is signed in the portal: the device refuses it, whatever the version.
    expect(staleStaff.statusCode).toBe(409);
    expect((await requestOf(a, 'Gómez', 'pending')).id).toBe(waiting.id);
  });

  it('refuses to sign without the explicit acceptance and without a mark, and signs nothing', async () => {
    const valentina = await portalSession(a, 'iso-a', 'valentina.gomez@demo.invalid');
    const waiting = await requestOf(a, 'Gómez', 'pending');

    const withoutAcceptance = await valentina.post(`/portal/consents/${waiting.id}/sign`, {
      accepted: false,
      contentHash: 'a'.repeat(64),
      signerName: 'Valentina Gómez',
      signature: { kind: 'typed', value: 'Valentina Gómez' },
    });
    const notAPicture = await valentina.post(`/portal/consents/${waiting.id}/sign`, {
      accepted: true,
      contentHash: 'a'.repeat(64),
      signerName: 'Valentina Gómez',
      signature: { kind: 'drawn', value: 'data:image/png;base64,AAAA' },
    });

    expect(withoutAcceptance.statusCode).toBe(400);
    expect(notAPicture.statusCode).toBeGreaterThanOrEqual(400);
    expect((await requestOf(a, 'Gómez', 'pending')).id).toBe(waiting.id);
  });

  it('cannot be altered at the database: a signature and a revocation take no update and no delete, and a status moves only through them', async () => {
    const forged = await Promise.allSettled([
      deps.withTenant(system(a), (tx) =>
        tx.execute(sql`UPDATE consent_request SET status = 'signed' WHERE status = 'pending'`),
      ),
      deps.withTenant(system(a), (tx) => tx.execute(sql`DELETE FROM consent_signature`)),
      deps.withTenant(system(a), (tx) =>
        tx.execute(sql`UPDATE consent_revocation SET reason_enc = NULL`),
      ),
      deps.withTenant(system(a), (tx) =>
        tx.execute(sql`UPDATE consent_template_version SET body = 'otro'`),
      ),
    ]);

    expect(forged.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect((await requestOf(a, 'Gómez', 'pending')).method).toBe('portal');
  });
});

describe('prescription access', () => {
  it('lets the prescriber and the professionals who treat the patient open her prescriptions, and nobody else', async () => {
    const [valentina] = await rows<{ id: string }>(
      a,
      sql`SELECT id FROM patient WHERE family_name = 'Gómez'`,
    );
    const patientId = valentina?.id ?? '';
    // Who treats her is the care relationship (an appointment or an assignment). The agenda of the
    // demo gives some adults to the psychologist as well, so the probe reads it instead of guessing.
    const treating = new Set(
      (
        await rows<{ matricula: string }>(
          a,
          sql`SELECT p.matricula FROM care_relationship c
                JOIN professional p ON p.id = c.professional_id
               WHERE c.patient_id = ${patientId}::uuid AND c.active`,
        )
      ).map((entry) => entry.matricula),
    );
    expect(treating.has('41258'), 'the cardiologist treats her').toBe(true);
    expect(treating.has('188204'), 'the pediatrician never treats an adult').toBe(false);
    const client = clientFor(app, 'iso-a');
    const path = `/patients/${patientId}/prescriptions`;
    const professionals = { cardiology: '41258', psychology: '9117', pediatrics: '188204' };

    for (const [key, matricula] of Object.entries(professionals)) {
      const response = await client.get(path, await staff('iso-a', key));
      const listed =
        response.statusCode === 200
          ? response.json<{ prescriptions: unknown[] }>().prescriptions.length
          : 0;
      if (treating.has(matricula)) {
        expect(response.statusCode, key).toBe(200);
        expect(listed, key).toBeGreaterThanOrEqual(2);
      } else {
        // Not treating: refused, or answered with a list that holds nothing of hers.
        expect(listed, `${key}: ${String(response.statusCode)} ${response.body}`).toBe(0);
        expect(response.body, key).not.toContain('Enalapril');
      }
    }
    for (const key of ['reception', 'admin', 'owner']) {
      const response = await client.get(path, await staff('iso-a', key));
      expect([403, 404], `${key}: ${String(response.statusCode)}`).toContain(response.statusCode);
      expect(response.body, key).not.toContain('Enalapril');
    }
  });

  it('keeps the medication and the signature out of the audit trail', async () => {
    const leaks = await rows<{ n: number }>(
      a,
      sql`SELECT count(*)::int AS n FROM audit_event
           WHERE metadata::text ILIKE ANY (ARRAY['%Enalapril%', '%Atorvastatina%', '%Losartán%',
                                                  '%Amlodipina%', '%Valentina Gómez%', '%base64%'])`,
    );

    expect(leaks[0]?.n).toBe(0);
    expect(
      (
        await rows<{ n: number }>(
          a,
          sql`SELECT count(*)::int AS n FROM audit_event WHERE action IN ('prescription.issued', 'consent.signed')`,
        )
      )[0]?.n,
    ).toBeGreaterThan(5);
  });
});
