import type { AuditAction, BrandingResponse } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let storage: MemoryObjectStorage;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let reception: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'branding-logo' });
  other = await createTestTenant(runtime, { slug: 'branding-logo-b' });
  storage = createMemoryObjectStorage();
  app = buildTestApplication(runtime, { storage });
  api = clientFor(app, 'branding-logo');
  owner = await signInAs(
    app,
    'branding-logo',
    await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
  );
  reception = await signInAs(
    app,
    'branding-logo',
    await createTestUser(runtime, tenant.id, { roles: ['reception'], password: TEST_PASSWORD }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function picture(format: 'png' | 'jpeg' | 'webp', width = 200, height = 100, exif = false) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#2255aa' } });
  if (exif) pipeline = pipeline.withExif({ IFD0: { Copyright: 'Secreto de quien lo sacó' } });
  return pipeline[format]().toBuffer();
}

const upload = (
  body: Buffer,
  contentType: string,
  session: TestSession | null = owner,
  slug = 'branding-logo',
) =>
  app.inject({
    method: 'PUT',
    url: '/branding/logo',
    headers: { ...browserHeaders(slug, session?.cookie), 'content-type': contentType },
    remoteAddress: '10.99.0.1',
    payload: body,
  });

async function auditRows(action: AuditAction = 'branding.logo_updated') {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('PUT /branding/logo', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'accepts a %s, stores a clean PNG and links it',
    async (format) => {
      const response = await upload(await picture(format), `image/${format}`);

      expect(response.statusCode).toBe(200);
      const logoUrl = response.json<BrandingResponse>().branding.logoUrl;
      expect(logoUrl).toMatch(/^\/public\/branding\/logo\?v=\d+$/);
      const keys = storage.keys().filter((key) => key.includes(tenant.id));
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^t/${tenant.id}/branding/logo-\\d+\\.png$`));
    },
  );

  it('serves the stored logo publicly from the tenant host, hardened against script', async () => {
    await upload(await picture('png'), 'image/png');
    const logoUrl =
      (await api.get('/branding', owner)).json<BrandingResponse>().branding.logoUrl ?? '';

    const response = await app.inject({
      method: 'GET',
      url: logoUrl,
      headers: { host: 'branding-logo.consultorio.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toContain('immutable');
    expect((await sharp(response.rawPayload).metadata()).format).toBe('png');
  });

  it('keeps the logo of one organization out of another', async () => {
    await upload(await picture('png'), 'image/png');

    const theirs = await app.inject({
      method: 'GET',
      url: '/public/branding/logo',
      headers: { host: 'branding-logo-b.consultorio.test' },
    });

    expect(theirs.statusCode).toBe(404);
    expect(other.slug).toBe('branding-logo-b');
  });

  it('strips the metadata of what it stores', async () => {
    await upload(await picture('jpeg', 100, 100, true), 'image/jpeg');
    const logoUrl =
      (await api.get('/branding', owner)).json<BrandingResponse>().branding.logoUrl ?? '';

    const served = await app.inject({
      method: 'GET',
      url: logoUrl,
      headers: { host: 'branding-logo.consultorio.test' },
    });

    expect((await sharp(served.rawPayload).metadata()).exif).toBeUndefined();
    expect(served.rawPayload.toString('latin1')).not.toContain('Secreto');
  });

  it('replaces the previous logo, removing its object, and audits it without the image', async () => {
    await upload(await picture('png', 100, 50), 'image/png');
    const second = await upload(await picture('png', 120, 60), 'image/png');

    expect(second.statusCode).toBe(200);
    expect(storage.keys().filter((key) => key.includes(tenant.id))).toHaveLength(1);
    const [row] = await auditRows();
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: owner.user.id,
      metadata: { width: 120, height: 60 },
    });
  });

  it('removes the logo on request', async () => {
    await upload(await picture('png'), 'image/png');

    const response = await api.delete('/branding/logo', owner);

    expect(response.statusCode).toBe(200);
    expect(response.json<BrandingResponse>().branding.logoUrl).toBeNull();
    expect(storage.keys().filter((key) => key.includes(tenant.id))).toHaveLength(0);
    expect((await auditRows())[0]).toMatchObject({ metadata: { removed: true } });
  });

  describe('refuses', () => {
    it('SVG, which can carry script: 415 before anything is read', async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );

      const response = await upload(svg, 'image/svg+xml');

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ code: 'bad_request' });
    });

    it.each(['text/html', 'application/octet-stream', 'image/gif', 'application/pdf'])(
      'a %s',
      async (type) => {
        expect((await upload(Buffer.from('x'), type)).statusCode).toBe(415);
      },
    );

    it('a polyglot: a valid PNG with a script after it', async () => {
      const polyglot = Buffer.concat([
        await picture('png'),
        Buffer.from('<script>alert(document.cookie)</script>'),
      ]);

      const response = await upload(polyglot, 'image/png');

      expect(response.statusCode).toBe(400);
      expect(response.json<{ errors: unknown[] }>().errors).toEqual([
        { path: 'logo', i18nKey: 'logo.trailing_data' },
      ]);
    });

    it('an executable or an SVG dressed as a PNG', async () => {
      const exe = await upload(
        Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 1)]),
        'image/png',
      );
      const svg = await upload(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'image/png',
      );

      for (const response of [exe, svg]) {
        expect(response.statusCode).toBe(400);
        expect(response.json<{ errors: unknown[] }>().errors).toEqual([
          { path: 'logo', i18nKey: 'logo.type_mismatch' },
        ]);
      }
    });

    it('a file over 512 KB, with 413', async () => {
      const noise = Buffer.alloc(513 * 1024, 0x42);

      const response = await upload(Buffer.concat([await picture('png'), noise]), 'image/png');

      expect(response.statusCode).toBe(413);
    });

    it('a picture with more than 2048 pixels on a side', async () => {
      const response = await upload(await picture('png', 2100, 8), 'image/png');

      expect(response.statusCode).toBe(400);
      expect(response.json<{ errors: unknown[] }>().errors).toEqual([
        { path: 'logo', i18nKey: 'logo.dimensions' },
      ]);
    });

    it('an empty body', async () => {
      expect((await upload(Buffer.alloc(0), 'image/png')).statusCode).toBe(400);
    });

    it('everything, from reception and from a visitor', async () => {
      const png = await picture('png');

      expect((await upload(png, 'image/png', reception)).statusCode).toBe(403);
      expect((await upload(png, 'image/png', null)).statusCode).toBe(401);
      expect((await api.delete('/branding/logo', reception)).statusCode).toBe(403);
    });
  });
});

describe('without object storage', () => {
  it('answers 503 for the upload instead of failing, and 404 for the public logo', async () => {
    const bare = buildTestApplication(runtime);
    await bare.ready();
    try {
      const session = await signInAs(bare, 'branding-logo', owner.user);
      const response = await bare.inject({
        method: 'PUT',
        url: '/branding/logo',
        headers: {
          ...browserHeaders('branding-logo', session.cookie),
          'content-type': 'image/png',
        },
        remoteAddress: '10.99.0.1',
        payload: await picture('png'),
      });
      const publicLogo = await bare.inject({
        method: 'GET',
        url: '/public/branding/logo',
        headers: { host: 'branding-logo.consultorio.test' },
      });

      expect(response.statusCode).toBe(503);
      expect(publicLogo.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
