import { randomBytes } from 'node:crypto';

import { DemoOutboxResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { demoOutboxDevProvider } from '../../src/adapters/demo-outbox/dev-routes.js';
import {
  createDemoOutboxEmailSender,
  createDemoOutboxReader,
} from '../../src/adapters/demo-outbox/index.js';
import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createAdapterResolver, createTenantRoutedEmail } from '../../src/main/adapter-resolver.js';
import { buildAdapterRegistry } from '../../src/main/adapters.js';
import { loadConfig } from '../../src/main/config.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { EmailDeliveryError } from '../../src/platform/mail/email-sender.js';
import { buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The demo outbox (task 5.48): what a demo organization "sends" is kept in `demo_outbox`, never
 * handed to a real mail server, listed in the provider console, and cleared by the demo reset.
 */

let runtime: DbHandle;
let operator: OperatorHarness;
let clock: TestClock;
let demoId: string;
let otherDemoId: string;
let customerId: string;

const KEK = randomBytes(32).toString('base64');
const BASE = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: KEK,
};

/** A deployment of the demo in production: the local providers are allowed, as a demo needs. */
const PRODUCTION = {
  NODE_ENV: 'production',
  ALLOW_LOCAL_PROVIDERS: 'true',
  ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  clock = createTestClock();
  demoId = (await createTestTenant(runtime, { slug: 'outbox-demo', isDemo: true })).id;
  otherDemoId = (await createTestTenant(runtime, { slug: 'outbox-demo-2', isDemo: true })).id;
  customerId = (await createTestTenant(runtime, { slug: 'outbox-customer' })).id;
});

afterAll(async () => {
  await operator.close();
  await runtime.close();
});

const message = (
  tenantId: string,
  isDemo: boolean,
  overrides: { to?: string; text?: string } = {},
) => ({
  to: overrides.to ?? 'paciente@demo.invalid',
  subject: 'Ingrese al portal: su código',
  text: overrides.text ?? 'Su código es:\n\n123456\n',
  tenant: { id: tenantId, isDemo },
});

function registryWith(env: Record<string, string>, smtp: ReturnType<typeof createFakeEmailSender>) {
  return buildAdapterRegistry({
    config: loadConfig({ ...BASE, ...env }),
    email: { kind: 'smtp', sender: smtp, close: () => undefined },
    storage: undefined,
    kms: createLocalKeyManagement(KEK),
    db: runtime.db,
    wiring: MODULE_WIRINGS,
  });
}

describe('the email sender of the demo organizations', () => {
  it('keeps the message with its address, subject, text and organization', async () => {
    const sender = createDemoOutboxEmailSender({ db: runtime.db });

    await sender.send(message(demoId, true, { to: 'ana@demo.invalid', text: 'Código 482913' }));

    const [found] = await createDemoOutboxReader(runtime.db).list({
      limit: 5,
      to: 'ANA@demo.invalid',
    });
    expect(found).toMatchObject({
      to: 'ana@demo.invalid',
      subject: 'Ingrese al portal: su código',
      text: 'Código 482913',
    });
  });

  it('hands a copy to the development catcher only when it is given one', async () => {
    const catcher = createFakeEmailSender();

    await createDemoOutboxEmailSender({ db: runtime.db, forward: catcher }).send(
      message(demoId, true, { to: 'copia@demo.invalid' }),
    );
    await createDemoOutboxEmailSender({ db: runtime.db }).send(
      message(demoId, true, { to: 'sin.copia@demo.invalid' }),
    );

    expect(catcher.sent.map((sent) => sent.to)).toEqual(['copia@demo.invalid']);
    const listed = await createDemoOutboxReader(runtime.db).list({ limit: 200 });
    expect(listed.map((entry) => entry.to)).toEqual(
      expect.arrayContaining(['copia@demo.invalid', 'sin.copia@demo.invalid']),
    );
  });

  it('refuses a message that does not say which organization it is about, and writes nothing', async () => {
    const sender = createDemoOutboxEmailSender({ db: runtime.db });

    await expect(
      sender.send({ to: 'huerfano@demo.invalid', subject: 'x', text: 'y' }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(
      await createDemoOutboxReader(runtime.db).list({ limit: 5, to: 'huerfano@demo.invalid' }),
    ).toEqual([]);
  });

  it('lists the newest first', async () => {
    const sender = createDemoOutboxEmailSender({ db: runtime.db });
    await sender.send(message(demoId, true, { to: 'orden@demo.invalid', text: 'primero' }));
    await sender.send(message(demoId, true, { to: 'orden@demo.invalid', text: 'segundo' }));

    const listed = await createDemoOutboxReader(runtime.db).list({
      limit: 5,
      to: 'orden@demo.invalid',
    });

    expect(listed.map((entry) => entry.text)).toEqual(['segundo', 'primero']);
  });
});

describe('the adapter registry', () => {
  it('never hands a demo email to the mail server in production, and keeps it in the outbox of a deployment with the console', async () => {
    const smtp = createFakeEmailSender();
    const resolver = createAdapterResolver(
      registryWith({ ...PRODUCTION, LOCAL_PROVIDERS_CONSOLE: 'true' }, smtp),
    );
    const email = createTenantRoutedEmail(resolver);

    await email.send(message(demoId, true, { to: 'solo.bandeja@demo.invalid' }));
    await email.send(message(customerId, false, { to: 'cliente@clinica.example' }));

    expect(smtp.sent.map((sent) => sent.to)).toEqual(['cliente@clinica.example']);
    const kept = await createDemoOutboxReader(runtime.db).list({
      limit: 50,
      to: 'solo.bandeja@demo.invalid',
    });
    expect(kept).toHaveLength(1);
    expect(
      await createDemoOutboxReader(runtime.db).list({ limit: 5, to: 'cliente@clinica.example' }),
    ).toEqual([]);
  });

  it('keeps nothing in production when the console is off: the demo email goes to a throwaway sender', async () => {
    const smtp = createFakeEmailSender();
    const email = createTenantRoutedEmail(createAdapterResolver(registryWith(PRODUCTION, smtp)));

    await email.send(message(demoId, true, { to: 'sin.consola@demo.invalid' }));

    expect(smtp.sent).toEqual([]);
    expect(
      await createDemoOutboxReader(runtime.db).list({ limit: 5, to: 'sin.consola@demo.invalid' }),
    ).toEqual([]);
  });

  it('keeps the outbox and also feeds the development catcher outside production', async () => {
    const catcher = createFakeEmailSender();
    const email = createTenantRoutedEmail(createAdapterResolver(registryWith({}, catcher)));

    await email.send(message(demoId, true, { to: 'desarrollo@demo.invalid' }));

    expect(catcher.sent.map((sent) => sent.to)).toEqual(['desarrollo@demo.invalid']);
    expect(
      await createDemoOutboxReader(runtime.db).list({ limit: 5, to: 'desarrollo@demo.invalid' }),
    ).toHaveLength(1);
  });
});

describe('the demo reset', () => {
  it('clears the outbox of the organization it resets and only that one', async () => {
    const sender = createDemoOutboxEmailSender({ db: runtime.db });
    await sender.send(message(demoId, true, { to: 'se.va@demo.invalid' }));
    await sender.send(message(otherDemoId, true, { to: 'se.queda@demo.invalid' }));

    const result = await operator.db.db.execute<{ outcome: { deleted: Record<string, number> } }>(
      sql`SELECT app.demo_reset(${demoId}::uuid) AS outcome`,
    );

    expect(result.rows[0]?.outcome.deleted['demo_outbox']).toBeGreaterThanOrEqual(1);
    const reader = createDemoOutboxReader(runtime.db);
    expect(await reader.list({ limit: 5, to: 'se.va@demo.invalid' })).toEqual([]);
    expect(await reader.list({ limit: 5, to: 'se.queda@demo.invalid' })).toHaveLength(1);
  });
});

describe('the demo outbox in the provider console', () => {
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    const options = {
      operator: { database: operator.db, secrets: operator.secrets },
      clock: clock.read,
    };
    const provider = demoOutboxDevProvider(createDemoOutboxReader(runtime.db));
    app = buildTestApplication(runtime, {
      ...options,
      localProviders: { console: true, providers: [provider] },
    });
    offApp = buildTestApplication(runtime, {
      ...options,
      localProviders: { console: false, providers: [provider] },
    });
    cookie = await operatorSession(app, await operator.addOperator(), clock);
    await offApp.ready();
  });

  afterAll(async () => {
    await app.close();
    await offApp.close();
  });

  const get = (target: FastifyInstance, url: string, session?: string) =>
    target.inject({
      method: 'GET',
      url,
      headers: platformHeaders(session),
      remoteAddress: '10.96.9.1',
    });

  it('shows the code of an email the demo sent, newest first, to the operator', async () => {
    const sender = createDemoOutboxEmailSender({ db: runtime.db });
    await sender.send(message(demoId, true, { to: 'consola@demo.invalid', text: 'Código 111111' }));
    await sender.send(message(demoId, true, { to: 'consola@demo.invalid', text: 'Código 222222' }));

    const response = await get(app, '/operator/dev/demo-outbox?to=consola%40demo.invalid', cookie);

    expect(response.statusCode, response.body).toBe(200);
    const { messages } = DemoOutboxResponse.parse(response.json());
    expect(messages.map((entry) => entry.text)).toEqual(['Código 222222', 'Código 111111']);
  });

  it('answers 401 without the operator session and has no route while the console is off', async () => {
    expect((await get(app, '/operator/dev/demo-outbox')).statusCode).toBe(401);
    expect((await get(offApp, '/operator/dev/demo-outbox', cookie)).statusCode).toBe(404);
  });

  it('is listed among the providers of the console', async () => {
    const response = await get(app, '/operator/dev/providers', cookie);

    expect(
      response.json<{ providers: { id: string; adapter: string }[] }>().providers,
    ).toContainEqual(expect.objectContaining({ id: 'demo-outbox', adapter: 'local' }));
  });
});
