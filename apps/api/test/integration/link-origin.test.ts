import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication, sessionCookieOf } from '../support/app.js';
import { TEST_PASSWORD } from '../support/session.js';
import { createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

/**
 * Security review finding 1: every emailed link is built from configuration. A forged `Host`
 * header must never change where a reset or an invitation link points.
 */
const PUBLIC_URL = 'https://agenda.clinica.example';
const EVIL = 'evil.example';

let runtime: DbHandle;
let single: FastifyInstance;
let multi: FastifyInstance;
let singleMail: FakeEmailSender;
let multiMail: FakeEmailSender;
let singleTenant: TestTenant;
let multiTenant: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  singleTenant = await createTestTenant(runtime, { slug: 'link-single' });
  multiTenant = await createTestTenant(runtime, { slug: 'link-multi' });
  singleMail = createFakeEmailSender();
  multiMail = createFakeEmailSender();
  single = buildTestApplication(runtime, {
    deployment: { mode: 'single', slug: 'link-single' },
    publicUrl: PUBLIC_URL,
    email: singleMail,
  });
  multi = buildTestApplication(runtime, { email: multiMail });
  await Promise.all([single.ready(), multi.ready()]);
});

afterAll(async () => {
  await single.close();
  await multi.close();
  await runtime.close();
});

const forged = (host: string, cookie?: string) => ({
  host,
  origin: `https://${host}`,
  'user-agent': 'vitest-browser',
  ...(cookie === undefined ? {} : { cookie }),
});

async function signIn(app: FastifyInstance, headers: Record<string, string>, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers,
    remoteAddress: '10.98.0.1',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookieOf(response.headers['set-cookie']);
}

describe('single-organization deployment (the host is not part of the identity)', () => {
  it('sends a reset link to the configured public URL even when the Host header is forged', async () => {
    const user = await createTestUser(runtime, singleTenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });

    const response = await single.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      headers: forged(EVIL),
      remoteAddress: '10.98.0.2',
      payload: { email: user.email },
    });
    await single.background.idle();

    expect(response.statusCode).toBe(204);
    const link = singleMail.linkIn(singleMail.lastTo(user.email));
    expect(link?.startsWith(`${PUBLIC_URL}/reset-password?token=`)).toBe(true);
    expect(link).not.toContain(EVIL);
  });

  it('sends an invitation link to the configured public URL even when the Host header is forged', async () => {
    const owner = await createTestUser(runtime, singleTenant.id, {
      roles: ['owner'],
      password: TEST_PASSWORD,
    });
    const cookie = await signIn(single, forged(EVIL), owner.email);

    const response = await single.inject({
      method: 'POST',
      url: '/staff/invitations',
      headers: forged(EVIL, cookie),
      remoteAddress: '10.98.0.2',
      payload: { email: 'nueva-recepcion@clinica.example', roles: ['reception'] },
    });

    expect(response.statusCode).toBe(201);
    const link = singleMail.linkIn(singleMail.lastTo('nueva-recepcion@clinica.example'));
    expect(link?.startsWith(`${PUBLIC_URL}/accept-invitation?token=`)).toBe(true);
    expect(link).not.toContain(EVIL);
  });

  it('sends the reset an administrator triggers to the configured public URL too', async () => {
    const admin = await createTestUser(runtime, singleTenant.id, {
      roles: ['admin'],
      password: TEST_PASSWORD,
    });
    const target = await createTestUser(runtime, singleTenant.id, { roles: ['reception'] });
    const cookie = await signIn(single, forged(EVIL), admin.email);

    const response = await single.inject({
      method: 'POST',
      url: `/users/${target.id}/password-reset`,
      headers: forged(EVIL, cookie),
      remoteAddress: '10.98.0.2',
      payload: {},
    });

    expect(response.statusCode).toBe(204);
    const link = singleMail.linkIn(singleMail.lastTo(target.email));
    expect(link?.startsWith(`${PUBLIC_URL}/reset-password?token=`)).toBe(true);
  });
});

describe('multi-organization deployment', () => {
  it('builds links from the base domain and the slug, ignoring a port in the Host header', async () => {
    const user = await createTestUser(runtime, multiTenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });

    const response = await multi.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      headers: {
        ...browserHeaders('link-multi'),
        host: 'link-multi.consultorio.test:6666',
        origin: 'https://link-multi.consultorio.test:6666',
      },
      remoteAddress: '10.98.0.3',
      payload: { email: user.email },
    });
    await multi.background.idle();

    expect(response.statusCode).toBe(204);
    const link = multiMail.linkIn(multiMail.lastTo(user.email));
    expect(link).toMatch(/^https:\/\/link-multi\.consultorio\.test\/reset-password\?token=/);
    expect(link).not.toContain('6666');
  });
});
