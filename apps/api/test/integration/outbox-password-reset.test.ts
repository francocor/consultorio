import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createOutboxEmailSender } from '../../src/adapters/outbox-email/index.js';
import {
  provisionLocalOrganization,
  type LocalProvisionDeps,
} from '../../src/db/seed/local/provision.js';
import { findAsset } from '../../src/main/assets.js';
import {
  createPasswordPolicy,
  createPasswordValidator,
  loadCommonPasswords,
} from '../../src/modules/identity/domain/password-policy.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { buildTestApplication } from '../support/app.js';

/**
 * The desktop install has no mail server, and the owner who forgot the password still has the
 * emailed route back: the message lands in the outbox folder, the tray shows its link, and the link
 * (built from PUBLIC_URL, never from a request) lets the owner choose a new password.
 */
const SLUG = 'outbox-reset';
const ORIGIN = 'http://127.0.0.1:41234';
const PASSWORD = 'una frase larga y privada del consultorio';
const NEW_PASSWORD = 'otra frase larga y nueva para entrar';
const EMAIL = 'ana@outbox-reset.example';

let runtime: DbHandle;
let dir: string;
let app: FastifyInstance;

const headers = { host: '127.0.0.1:41234', origin: ORIGIN, 'user-agent': 'vitest-browser' };
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers, remoteAddress: '127.0.0.1', payload });

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  dir = await mkdtemp(join(tmpdir(), 'consulvia-outbox-reset-'));
  const deps: LocalProvisionDeps = {
    db: runtime.db,
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    validator: createPasswordValidator(
      createPasswordPolicy(await loadCommonPasswords(findAsset('common-passwords-100k.txt'))),
    ),
    clock: () => new Date(),
  };
  await provisionLocalOrganization(deps, {
    organizationName: 'Clínica Outbox',
    slug: SLUG,
    ownerName: 'Dra. Ana Gómez',
    ownerEmail: EMAIL,
    ownerPassword: PASSWORD,
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  app = buildTestApplication(runtime, {
    deployment: { mode: 'single', slug: SLUG },
    cookieSecure: false,
    publicUrl: ORIGIN,
    email: createOutboxEmailSender({ dir, from: 'Consulvia <no-responder@localhost>' }),
    wiring: [],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a password reset on an install with no mail server', () => {
  it('writes the reset message to the outbox with a link on the local address, and the link works', async () => {
    const requested = await post('/auth/password-reset/request', { email: EMAIL });
    await app.background.idle();
    expect(requested.statusCode).toBe(204);

    const names = await readdir(dir);
    const entryName = names.find((name) => name.endsWith('.json'));
    expect(names.filter((name) => name.endsWith('.eml'))).toHaveLength(1);
    const entry = JSON.parse(await readFile(join(dir, entryName ?? ''), 'utf8')) as {
      to: string;
      links: string[];
    };
    expect(entry.to).toBe(EMAIL);
    expect(entry.links).toHaveLength(1);
    const link = new URL(entry.links[0] ?? '');
    expect(link.origin).toBe(ORIGIN);
    const token = link.searchParams.get('token') ?? '';

    const completed = await post('/auth/password-reset/complete', {
      token,
      password: NEW_PASSWORD,
    });
    expect(completed.statusCode).toBe(204);
    expect((await post('/auth/login', { email: EMAIL, password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/auth/login', { email: EMAIL, password: NEW_PASSWORD })).statusCode).toBe(
      200,
    );
  });
});
