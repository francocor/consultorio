import type {
  CredentialSummaryDto,
  FiscalConfigResponse,
  InvoiceIssuer,
  InvoicingReadinessDto,
  PointOfSaleDto,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeInvoiceIssuer } from '../../src/adapters/afip-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { fiscalCredential } from '../../src/db/schema/index.js';
import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { captureLogs } from '../../src/testing/log-capture.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

/**
 * Fiscal configuration (S4.08, tasks 4.36 to 4.38): the profile, the points of sale, the readiness
 * for issuing and the certificate, through the real application.
 */

const CUIT = '20-12345678-6';
const CUIT_DIGITS = '20123456786';

/** The issuer the resolver hands out: a simulator, a real-looking one, or none. */
const issuers: { current: InvoiceIssuer | undefined } = { current: createFakeInvoiceIssuer() };
const realLooking = (): InvoiceIssuer => ({
  issue: () => Promise.resolve({ status: 'rejected', message: 'unused' }),
  findIssued: () => Promise.resolve(null),
});
const resolver: AdapterResolver = {
  forTenant: (_tenant, port) => (port === 'invoiceIssuer' ? issuers.current : undefined) as never,
};

const logs = captureLogs();
let runtime: DbHandle;
let app: FastifyInstance;
let a: TestTenant;
let b: TestTenant;
let api: ReturnType<typeof clientFor>;
let apiB: ReturnType<typeof clientFor>;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let professional: TestSession;
let ownerB: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'fiscal-a' });
  b = await createTestTenant(runtime, { slug: 'fiscal-b' });
  app = buildTestApplication(runtime, {
    adapters: resolver,
    logLevel: 'info',
    logStream: logs.stream,
  });
  api = clientFor(app, 'fiscal-a');
  apiB = clientFor(app, 'fiscal-b');
  const make = (tenant: TestTenant, roles: ('owner' | 'admin' | 'reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  owner = await signInAs(app, 'fiscal-a', await make(a, ['owner']));
  admin = await signInAs(app, 'fiscal-a', await make(a, ['admin']));
  reception = await signInAs(app, 'fiscal-a', await make(a, ['reception']));
  professional = await signInAs(app, 'fiscal-a', await make(a, ['professional']));
  ownerB = await signInAs(app, 'fiscal-b', await make(b, ['owner']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const config = async (session: TestSession = owner) =>
  (await api.get('/invoicing/config', session)).json<FiscalConfigResponse>();
const readiness = async (session: TestSession = reception) =>
  (await api.get('/invoicing/readiness', session)).json<InvoicingReadinessDto>();

const profileBody = (overrides: Record<string, unknown> = {}) => ({
  cuit: CUIT,
  taxCondition: 'monotributo',
  businessName: 'Consultorio Aillu',
  address: 'Av. Siempre Viva 123, CABA',
  activityStartedOn: '2020-03-01',
  ...overrides,
});

async function auditRows(action: string, tenantId = a.id) {
  return asTenant(runtime, tenantId, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.action, action as never)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

async function switchEinvoicing(enabled: boolean, session = owner) {
  const response = await api.patch('/settings', session, { integrations: { einvoicing: enabled } });
  expect(response.statusCode).toBe(200);
}

describe('who may configure invoicing', () => {
  it('lets the owner and the admin read the configuration and refuses reception and professionals', async () => {
    expect((await api.get('/invoicing/config', owner)).statusCode).toBe(200);
    expect((await api.get('/invoicing/config', admin)).statusCode).toBe(200);
    expect((await api.get('/invoicing/config', reception)).statusCode).toBe(403);
    expect((await api.get('/invoicing/config', professional)).statusCode).toBe(403);
  });

  it('refuses every change to reception, and records the denial', async () => {
    const changed = (await auditRows('invoicing.config.changed')).length;
    const denied = (await auditRows('access.denied')).length;

    const response = await api.put('/invoicing/profile', reception, profileBody());

    expect(response.statusCode).toBe(403);
    expect((await auditRows('invoicing.config.changed')).length).toBe(changed);
    expect((await auditRows('access.denied')).length).toBe(denied + 1);
  });

  it('answers 401 without a session', async () => {
    expect((await api.get('/invoicing/config', null)).statusCode).toBe(401);
  });
});

describe('the fiscal profile (task 4.36)', () => {
  it('starts empty for a new organization', async () => {
    expect(await config()).toMatchObject({
      enabled: false,
      profile: null,
      pointsOfSale: [],
      credential: null,
    });
  });

  it('saves the identity with the CUIT normalized to digits, and changes it later', async () => {
    const saved = await api.put('/invoicing/profile', owner, profileBody());

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      cuit: CUIT_DIGITS,
      taxCondition: 'monotributo',
      businessName: 'Consultorio Aillu',
      address: 'Av. Siempre Viva 123, CABA',
      activityStartedOn: '2020-03-01',
    });
    const changed = await api.put(
      '/invoicing/profile',
      admin,
      profileBody({ businessName: 'Centro Aillu SRL', taxCondition: 'responsable_inscripto' }),
    );
    expect(changed.json()).toMatchObject({
      businessName: 'Centro Aillu SRL',
      taxCondition: 'responsable_inscripto',
    });
    expect((await config()).profile?.businessName).toBe('Centro Aillu SRL');
  });

  it('audits each change by the fields touched, never by their values', async () => {
    const rows = await auditRows('invoicing.config.changed');

    const profileRows = rows.filter((row) => row.metadata['section'] === 'profile');
    expect(profileRows.length).toBeGreaterThanOrEqual(2);
    const latest = profileRows[0];
    expect(latest?.metadata['changedFields']).toEqual(['taxCondition', 'businessName']);
    expect(JSON.stringify(latest?.metadata)).not.toContain('Aillu');
    expect(latest?.resourceType).toBe('fiscal_profile');
  });

  it('rejects a CUIT with a wrong check digit with the validation message', async () => {
    const response = await api.put(
      '/invoicing/profile',
      owner,
      profileBody({ cuit: '20-12345678-5' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'cuit', i18nKey: 'country.ar.tax_id.invalid' }],
    });
    expect((await config()).profile?.cuit).toBe(CUIT_DIGITS);
  });

  it('rejects a start of activities in the future', async () => {
    const response = await api.put(
      '/invoicing/profile',
      owner,
      profileBody({ activityStartedOn: '2999-01-01' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [{ path: 'activityStartedOn', i18nKey: 'invoicing.profile.activity_in_future' }],
    });
  });

  it('keeps each organization to its own profile', async () => {
    expect(
      (await apiB.get('/invoicing/config', ownerB)).json<FiscalConfigResponse>().profile,
    ).toBeNull();
  });
});

describe('points of sale (task 4.36)', () => {
  let first: PointOfSaleDto;
  let second: PointOfSaleDto;

  it('creates points of sale, homologation unless told otherwise', async () => {
    const one = await api.post('/invoicing/points-of-sale', owner, { number: 1 });
    const two = await api.post('/invoicing/points-of-sale', owner, {
      number: 2,
      environment: 'production',
    });

    expect(one.statusCode).toBe(201);
    first = one.json<PointOfSaleDto>();
    second = two.json<PointOfSaleDto>();
    expect(first).toMatchObject({ number: 1, environment: 'homologation', active: true });
    expect(second).toMatchObject({ number: 2, environment: 'production', active: true });
  });

  it('refuses a repeated number with a conflict', async () => {
    const response = await api.post('/invoicing/points-of-sale', owner, { number: 1 });

    expect(response.statusCode).toBe(409);
  });

  it('gives each point of sale its own environment when the issuer is a real one', async () => {
    issuers.current = realLooking();

    const points = (await config()).pointsOfSale;

    expect(
      points.map((point) => [point.number, point.environment, point.effectiveEnvironment]),
    ).toEqual([
      [1, 'homologation', 'homologation'],
      [2, 'production', 'production'],
    ]);
  });

  it('forces homologation on every point of sale while the issuer is a simulator', async () => {
    issuers.current = createFakeInvoiceIssuer();

    const points = (await config()).pointsOfSale;

    expect(
      points.map((point) => [point.number, point.environment, point.effectiveEnvironment]),
    ).toEqual([
      [1, 'homologation', 'homologation'],
      [2, 'production', 'homologation'],
    ]);
    expect((await config()).readiness.simulated).toBe(true);
  });

  it('changes the environment and deactivates, auditing both', async () => {
    const changed = await api.patch(`/invoicing/points-of-sale/${first.id}`, owner, {
      environment: 'production',
    });
    const off = await api.patch(`/invoicing/points-of-sale/${second.id}`, admin, { active: false });

    expect(changed.json()).toMatchObject({ number: 1, environment: 'production' });
    expect(off.json()).toMatchObject({ number: 2, active: false });
    const rows = (await auditRows('invoicing.config.changed')).filter(
      (row) => row.metadata['section'] === 'point_of_sale',
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((row) => row.metadata['changedFields'] !== undefined)).toBe(true);
    await api.patch(`/invoicing/points-of-sale/${first.id}`, owner, {
      environment: 'homologation',
    });
    await api.patch(`/invoicing/points-of-sale/${second.id}`, owner, { active: true });
  });

  it('answers not found for a point of sale of another organization or an unknown id', async () => {
    const foreign = await apiB.post('/invoicing/points-of-sale', ownerB, { number: 1 });
    const id = foreign.json<PointOfSaleDto>().id;

    expect(
      (await api.patch(`/invoicing/points-of-sale/${id}`, owner, { active: false })).statusCode,
    ).toBe(404);
    expect(
      (
        await api.patch('/invoicing/points-of-sale/0190a000-0000-7000-8000-000000000001', owner, {
          active: false,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a number out of range and an empty change', async () => {
    expect((await api.post('/invoicing/points-of-sale', owner, { number: 0 })).statusCode).toBe(
      400,
    );
    expect(
      (await api.post('/invoicing/points-of-sale', owner, { number: 100000 })).statusCode,
    ).toBe(400);
    expect((await api.patch(`/invoicing/points-of-sale/${first.id}`, owner, {})).statusCode).toBe(
      400,
    );
  });
});

describe('readiness to issue (tasks 4.36 and 4.38)', () => {
  it('is blocked while the organization has not switched e-invoicing on', async () => {
    issuers.current = createFakeInvoiceIssuer();

    expect(await readiness()).toEqual({
      available: false,
      reasons: ['disabled'],
      simulated: true,
    });
  });

  it('is available with a profile and an active point of sale once it is switched on', async () => {
    await switchEinvoicing(true);

    expect(await readiness()).toEqual({ available: true, reasons: [], simulated: true });
  });

  it('is blocked again when the owner switches it off, and the configuration stays', async () => {
    await switchEinvoicing(false, admin);

    expect(await readiness()).toMatchObject({ available: false, reasons: ['disabled'] });
    expect((await config()).profile).not.toBeNull();
    await switchEinvoicing(true);
  });

  it('lets only the owner and the admin switch e-invoicing, and audits the switch under its own action', async () => {
    const refused = await api.patch('/settings', reception, {
      integrations: { einvoicing: false },
    });
    const before = (await auditRows('invoicing.config.changed')).length;

    await switchEinvoicing(false);
    await switchEinvoicing(true, admin);

    expect(refused.statusCode).toBe(403);
    const rows = (await auditRows('invoicing.config.changed')).slice(0, 2);
    expect((await auditRows('invoicing.config.changed')).length).toBe(before + 2);
    expect(rows.map((row) => [row.metadata['field'], row.metadata['enabled']])).toEqual([
      ['einvoicing', true],
      ['einvoicing', false],
    ]);
  });

  it('blocks issuing for an organization with no profile and no point of sale', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-empty' });
    const user = await createTestUser(runtime, c.id, { roles: ['owner'], password: TEST_PASSWORD });
    const session = await signInAs(app, 'fiscal-empty', user);
    const empty = clientFor(app, 'fiscal-empty');
    await empty.patch('/settings', session, { integrations: { einvoicing: true } });

    const response = await empty.get('/invoicing/readiness', session);

    expect(response.json()).toEqual({
      available: false,
      reasons: ['profile_missing', 'point_of_sale_missing'],
      simulated: true,
    });
  });

  it('needs a point of sale that is active', async () => {
    const points = (await config()).pointsOfSale;
    for (const point of points) {
      await api.patch(`/invoicing/points-of-sale/${point.id}`, owner, { active: false });
    }

    expect((await readiness()).reasons).toEqual(['point_of_sale_missing']);

    for (const point of points) {
      await api.patch(`/invoicing/points-of-sale/${point.id}`, owner, { active: true });
    }
    expect((await readiness()).available).toBe(true);
  });

  it('is blocked when no issuer serves the organization (AFIP_PROVIDER=off)', async () => {
    issuers.current = undefined;

    expect(await readiness()).toMatchObject({ available: false, reasons: ['issuer_unavailable'] });
    issuers.current = createFakeInvoiceIssuer();
  });

  it('can be read by reception, which issues, and not by a professional', async () => {
    expect((await api.get('/invoicing/readiness', reception)).statusCode).toBe(200);
    expect((await api.get('/invoicing/readiness', owner)).statusCode).toBe(200);
    expect((await api.get('/invoicing/readiness', professional)).statusCode).toBe(403);
  });
});

describe('the credential (task 4.37)', () => {
  const upload = (session: TestSession, body: unknown) =>
    api.put('/invoicing/credentials', session, body);
  const dev = (options: { cuit?: string; validDays?: number; ageDays?: number } = {}) =>
    generateDevCertificate({ cuit: options.cuit ?? CUIT_DIGITS, algorithm: 'ec', ...options });

  it('needs the fiscal profile first, because the certificate is checked against its CUIT', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-noprofile' });
    const user = await createTestUser(runtime, c.id, { roles: ['owner'], password: TEST_PASSWORD });
    const session = await signInAs(app, 'fiscal-noprofile', user);
    const made = dev();

    const response = await clientFor(app, 'fiscal-noprofile').put(
      '/invoicing/credentials',
      session,
      {
        certificate: made.certificate,
        privateKey: made.privateKey,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'fiscal_profile_required' });
  });

  it('is only for the owner and the admin', async () => {
    const made = dev();
    const body = { certificate: made.certificate, privateKey: made.privateKey };

    expect((await upload(reception, body)).statusCode).toBe(403);
    expect((await upload(professional, body)).statusCode).toBe(403);
  });

  it('stores a valid certificate and answers with its state, never with the certificate or the key', async () => {
    const made = dev();

    const response = await upload(owner, {
      certificate: made.certificate,
      privateKey: made.privateKey,
    });

    expect(response.statusCode).toBe(200);
    const summary = response.json<CredentialSummaryDto>();
    expect(summary).toMatchObject({ state: 'valid', subjectCuit: CUIT_DIGITS });
    expect(summary.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(summary.notAfter)).toEqual(made.notAfter);
    expect(response.body).not.toContain('BEGIN');
    expect(response.body).not.toContain(made.privateKey.split('\n')[1] ?? 'unreachable');
    expect((await config()).credential).toEqual(summary);
    expect(JSON.stringify(await config(admin))).not.toContain('PRIVATE');
  });

  it('keeps ciphertext only: raw SQL shows neither PEM, and the tenant key opens it', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(fiscalCredential).where(eq(fiscalCredential.active, true)),
    );

    expect(row).toBeDefined();
    expect(row?.certificateEnc.toString('latin1')).not.toContain('CERTIFICATE');
    expect(row?.privateKeyEnc.toString('latin1')).not.toContain('PRIVATE KEY');
    expect(row?.certificateEnc.length).toBeGreaterThan(100);
  });

  it('never writes the certificate or the key to the logs', async () => {
    const made = dev();

    await upload(owner, { certificate: made.certificate, privateKey: made.privateKey });
    const failed = await upload(owner, {
      certificate: made.certificate,
      privateKey: 'broken key text',
    });

    expect(failed.statusCode).toBe(400);
    const raw = logs.raw();
    expect(raw).not.toContain('BEGIN');
    expect(raw).not.toContain('broken key text');
    for (const line of made.privateKey.split('\n').filter((text) => text.length > 20)) {
      expect(raw).not.toContain(line);
    }
  });

  it('audits an upload by the fingerprint and the expiry, nothing else', async () => {
    const [latest] = await auditRows('invoicing.credential.changed');

    expect(latest?.resourceType).toBe('fiscal_credential');
    expect(Object.keys(latest?.metadata ?? {}).sort()).toEqual([
      'fingerprint',
      'notAfter',
      'state',
    ]);
    expect(JSON.stringify(latest?.metadata)).not.toContain('BEGIN');
  });

  it('keeps only one active credential: a new upload replaces the old one, which stays as history', async () => {
    const before = await asTenant(runtime, a.id, (tx) => tx.select().from(fiscalCredential));
    const made = dev();

    await upload(admin, { certificate: made.certificate, privateKey: made.privateKey });

    const after = await asTenant(runtime, a.id, (tx) => tx.select().from(fiscalCredential));
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((row) => row.active)).toHaveLength(1);
    expect(after.find((row) => row.active)?.fingerprint).toBe(
      (await config()).credential?.fingerprint,
    );
  });

  it.each([
    [
      'a key that belongs to another certificate',
      () => ({ certificate: dev().certificate, privateKey: dev().privateKey }),
      'privateKey',
      'invoicing.credential.key_mismatch',
    ],
    [
      'a certificate of another CUIT',
      () => {
        const made = dev({ cuit: '30712345671' });
        return { certificate: made.certificate, privateKey: made.privateKey };
      },
      'certificate',
      'invoicing.credential.cuit_mismatch',
    ],
    [
      'text that is not a certificate',
      () => ({ certificate: 'hello', privateKey: dev().privateKey }),
      'certificate',
      'invoicing.credential.certificate_unreadable',
    ],
    [
      'an expired certificate',
      () => {
        const made = dev({ validDays: 30, ageDays: 90 });
        return { certificate: made.certificate, privateKey: made.privateKey };
      },
      'certificate',
      'invoicing.credential.expired',
    ],
  ])('refuses %s', async (_name, body, path, key) => {
    const before = (await config()).credential?.fingerprint;

    const response = await upload(owner, body());

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path, i18nKey: key }] });
    expect((await config()).credential?.fingerprint).toBe(before);
  });

  it('reports a certificate in its last 30 days as expiring, and still lets invoicing run', async () => {
    const made = dev({ validDays: 365, ageDays: 345 });

    const response = await upload(owner, {
      certificate: made.certificate,
      privateKey: made.privateKey,
    });

    expect(response.json<CredentialSummaryDto>().state).toBe('expiring');
    expect((await readiness()).available).toBe(true);
  });

  it('blocks a real issuer without a credential, and a simulator does not need one', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-nocredential' });
    const user = await createTestUser(runtime, c.id, { roles: ['owner'], password: TEST_PASSWORD });
    const session = await signInAs(app, 'fiscal-nocredential', user);
    const own = clientFor(app, 'fiscal-nocredential');
    await own.patch('/settings', session, { integrations: { einvoicing: true } });
    await own.put('/invoicing/profile', session, profileBody());
    await own.post('/invoicing/points-of-sale', session, { number: 1 });

    issuers.current = realLooking();
    const real = (await own.get('/invoicing/readiness', session)).json<InvoicingReadinessDto>();
    issuers.current = createFakeInvoiceIssuer();
    const simulated = (
      await own.get('/invoicing/readiness', session)
    ).json<InvoicingReadinessDto>();

    expect(real).toEqual({ available: false, reasons: ['credential_missing'], simulated: false });
    expect(simulated).toEqual({ available: true, reasons: [], simulated: true });
  });

  it('blocks issuing with an expired certificate and with one for another CUIT, whoever issues', async () => {
    const [active] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(fiscalCredential).where(eq(fiscalCredential.active, true)),
    );
    const original = active?.notAfter;
    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql`UPDATE fiscal_credential SET not_after = now() - interval '1 day', not_before = now() - interval '400 days' WHERE id = ${active?.id}`,
      ),
    );

    const expired = await readiness();
    await api.put('/invoicing/profile', owner, profileBody({ cuit: '30-71234567-1' }));
    const mismatched = await readiness();
    await api.put('/invoicing/profile', owner, profileBody());

    expect(expired.reasons).toEqual(['credential_expired']);
    expect(mismatched.reasons).toEqual(['credential_invalid']);
    expect(original).toBeDefined();
  });
});
