import { randomUUID } from 'node:crypto';

import type { PutCredentialRequest } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { fiscalCredential } from '../../src/db/schema/index.js';
import {
  CREDENTIAL_WATCH_JOB,
  createCredentialWatchJob,
} from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

/**
 * The credential watch (task 4.37): the owner is emailed once when the certificate is within 30
 * days of its end, and the email says nothing about the certificate itself.
 */

const email = createFakeEmailSender();
const DAY = 86_400_000;
const CUIT = '20123456786';
let runtime: DbHandle;
let app: FastifyInstance;
let now: Date;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  now = new Date();
  app = buildTestApplication(runtime, { clock: () => now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

interface World {
  tenant: TestTenant;
  owner: TestUser;
  secondOwner: TestUser;
  admin: TestUser;
  session: TestSession;
  upload(validDays: number, ageDays: number): Promise<void>;
}

let counter = 0;
async function world(): Promise<World> {
  counter += 1;
  const slug = `fiscal-watch-${String(counter)}`;
  const tenant = await createTestTenant(runtime, { slug });
  const user = (roles: ('owner' | 'admin')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  const owner = await user(['owner']);
  const secondOwner = await user(['owner']);
  const admin = await user(['admin']);
  const session = await signInAs(app, slug, owner);
  const api = clientFor(app, slug);
  await api.put('/invoicing/profile', session, {
    cuit: CUIT,
    taxCondition: 'monotributo',
    businessName: 'Consultorio',
    address: 'Calle 1',
    activityStartedOn: '2020-01-01',
  });
  return {
    tenant,
    owner,
    secondOwner,
    admin,
    session,
    async upload(validDays, ageDays) {
      const made = generateDevCertificate({ cuit: CUIT, now, validDays, ageDays, algorithm: 'ec' });
      const body: PutCredentialRequest = {
        certificate: made.certificate,
        privateKey: made.privateKey,
      };
      const response = await api.put('/invoicing/credentials', session, body);
      expect(response.statusCode).toBe(200);
    },
  };
}

const job = () => createCredentialWatchJob({ email, clock: () => now });

async function watch(tenantId: string) {
  return runJob(runtime.db, job(), {
    id: randomUUID(),
    name: CREDENTIAL_WATCH_JOB,
    data: { tenantId },
    enqueuedAt: now,
    retryCount: 0,
  });
}

describe('the credential watch job', () => {
  it('is the job of the queue the seam registered', () => {
    expect(job().name).toBe('fiscal.credential_watch');
    expect(job().category).toBe('write');
  });

  it('emails every owner, and only the owners, when the certificate has 20 days left', async () => {
    const w = await world();
    await w.upload(365, 345);
    email.clear();

    const result = await watch(w.tenant.id);

    expect(result).toEqual({ status: 'completed' });
    expect(email.sent.map((message) => message.to).sort()).toEqual(
      [w.owner.email, w.secondOwner.email].sort(),
    );
    const message = email.sent[0];
    expect(message?.subject).toMatch(/certificado/i);
    expect(message?.text).toContain('20 días');
    expect(message?.text).toContain(
      DateTime.fromMillis(now.getTime() + 20 * DAY, {
        zone: 'America/Argentina/Buenos_Aires',
      }).toFormat('dd/MM/yyyy'),
    );
    expect(message?.tenant).toEqual({ id: w.tenant.id, isDemo: false });
  });

  it('never puts the certificate, the key or the fingerprint in the email', async () => {
    const w = await world();
    await w.upload(365, 340);
    email.clear();

    await watch(w.tenant.id);

    const [row] = await asTenant(runtime, w.tenant.id, (tx) => tx.select().from(fiscalCredential));
    for (const message of email.sent) {
      expect(`${message.subject}\n${message.text}\n${message.html ?? ''}`).not.toMatch(
        /BEGIN|PRIVATE|CERTIFICATE/,
      );
      expect(message.text).not.toContain(row?.fingerprint ?? 'unreachable');
    }
    expect(email.sent.length).toBe(2);
  });

  it('warns once per certificate: a second run sends nothing, a new certificate warns again', async () => {
    const w = await world();
    await w.upload(365, 340);
    email.clear();

    await watch(w.tenant.id);
    const first = email.sent.length;
    await watch(w.tenant.id);
    const second = email.sent.length;
    await w.upload(365, 345);
    await watch(w.tenant.id);

    expect(first).toBe(2);
    expect(second).toBe(2);
    expect(email.sent.length).toBe(4);
  });

  it('sends nothing for a certificate with more than 30 days left, and none for no certificate', async () => {
    const healthy = await world();
    await healthy.upload(365, 0);
    const empty = await world();
    email.clear();

    await watch(healthy.tenant.id);
    await watch(empty.tenant.id);

    expect(email.sent).toEqual([]);
  });

  it('warns at exactly 30 days and says the certificate expired when it already did', async () => {
    const w = await world();
    await w.upload(365, 335);
    email.clear();
    await watch(w.tenant.id);
    expect(email.sent[0]?.text).toContain('30 días');

    const late = await world();
    await late.upload(60, 0);
    now = new Date(now.getTime() + 61 * DAY);
    email.clear();
    await watch(late.tenant.id);
    now = new Date(now.getTime() - 61 * DAY);

    expect(email.sent[0]?.subject).toMatch(/venci/i);
  });

  it('marks the certificate as warned in the same transaction that sent the email', async () => {
    const w = await world();
    await w.upload(365, 340);

    await watch(w.tenant.id);

    const [row] = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(fiscalCredential).where(eq(fiscalCredential.active, true)),
    );
    expect(row?.expiryWarnedAt).not.toBeNull();
  });

  it('does not mark it when no email could be sent, so the next run tries again', async () => {
    const w = await world();
    await w.upload(365, 340);
    const broken = createFakeEmailSender({ failWith: new Error('smtp down') });

    await expect(
      runJob(runtime.db, createCredentialWatchJob({ email: broken, clock: () => now }), {
        id: randomUUID(),
        name: CREDENTIAL_WATCH_JOB,
        data: { tenantId: w.tenant.id },
        enqueuedAt: now,
        retryCount: 0,
      }),
    ).rejects.toThrow();

    const [row] = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(fiscalCredential).where(eq(fiscalCredential.active, true)),
    );
    expect(row?.expiryWarnedAt).toBeNull();
  });
});
