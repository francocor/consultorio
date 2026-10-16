import { BootPayload, WebManifest } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { tenant as tenantTable, tenantFeature } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let app: FastifyInstance;
let clinic: TestTenant;
let demo: TestTenant;
let plain: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  clinic = await createTestTenant(runtime, { slug: 'boot-clinic' });
  demo = await createTestTenant(runtime, { slug: 'boot-demo', isDemo: true });
  plain = await createTestTenant(runtime, { slug: 'boot-plain' });
  await asTenant(runtime, clinic.id, async (tx) => {
    await tx
      .update(tenantTable)
      .set({
        theme: {
          displayName: 'Centro Norte',
          shortName: 'Norte',
          primaryRequested: '#1d4ed8',
          radius: 'lg',
          headingFont: 'lora',
          logo: { key: 'ignored', version: 3, width: 100, height: 50 },
        },
      })
      .where(eq(tenantTable.id, clinic.id));
    await tx.insert(tenantFeature).values([
      { tenantId: clinic.id, feature: 'online_booking', enabled: true },
      { tenantId: clinic.id, feature: 'whatsapp', enabled: false },
    ]);
  });
  await asTenant(runtime, demo.id, (tx) =>
    tx
      .update(tenantTable)
      .set({ theme: { displayName: 'Consultorio Demo', primaryRequested: '#b91c1c' } })
      .where(eq(tenantTable.id, demo.id)),
  );
  app = buildTestApplication(runtime, { storage: createMemoryObjectStorage() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const get = (url: string, slug: string) =>
  app.inject({ method: 'GET', url, headers: browserHeaders(slug), remoteAddress: '10.98.0.1' });

describe('GET /public/boot', () => {
  it('answers without a session with the branding of the host', async () => {
    const response = await get('/public/boot', 'boot-clinic');

    expect(response.statusCode).toBe(200);
    const boot = BootPayload.parse(response.json());
    expect(boot).toMatchObject({
      name: 'Centro Norte',
      shortName: 'Norte',
      theme: { primary: '#1d4ed8', radius: 'lg', headingFont: 'lora' },
      logoUrl: '/public/branding/logo?v=3',
      deploymentMode: 'multi',
      isDemo: false,
    });
  });

  it('carries nothing but the whitelisted keys and no identifiers', async () => {
    const body = (await get('/public/boot', 'boot-clinic')).json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(
      [
        'deploymentMode',
        'features',
        'isDemo',
        'locale',
        'logoUrl',
        'name',
        'shortName',
        'theme',
      ].sort(),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain(clinic.id);
    expect(text).not.toContain('boot-clinic');
    expect(text).not.toContain('ignored');
  });

  it('lists only the features that are on', async () => {
    const boot = (await get('/public/boot', 'boot-clinic')).json<BootPayload>();

    expect(boot.features).toEqual(['online_booking']);
  });

  it('gives two hosts two different themes', async () => {
    const a = (await get('/public/boot', 'boot-clinic')).json<BootPayload>();
    const b = (await get('/public/boot', 'boot-demo')).json<BootPayload>();

    expect(a.theme.primary).not.toBe(b.theme.primary);
    expect(a.name).not.toBe(b.name);
    expect(b.isDemo).toBe(true);
  });

  it('falls back to the product defaults and the slug until the organization sets a name', async () => {
    const boot = (await get('/public/boot', 'boot-plain')).json<BootPayload>();

    expect(boot.name).toBe(plain.slug);
    expect(boot.logoUrl).toBeNull();
    expect(boot.features).toEqual([]);
    expect(boot.locale).toBe('es-AR');
  });

  it('is not served from the platform host or an unknown host', async () => {
    const platform = await app.inject({
      method: 'GET',
      url: '/public/boot',
      headers: { host: 'platform.consultorio.test', 'user-agent': 'vitest-browser' },
      remoteAddress: '10.98.0.1',
    });
    const unknown = await get('/public/boot', 'no-such-clinic');

    expect(platform.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
  });
});

describe('GET /manifest.webmanifest', () => {
  it('is generated per host from its branding', async () => {
    const response = await get('/manifest.webmanifest', 'boot-clinic');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/manifest+json');
    const manifest = WebManifest.parse(response.json());
    expect(manifest).toMatchObject({
      name: 'Centro Norte',
      short_name: 'Norte',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#1d4ed8',
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
    expect(manifest.icons[0]?.src).toBe('/public/branding/logo?size=192&v=3');
  });

  it('differs between two hosts', async () => {
    const a = (await get('/manifest.webmanifest', 'boot-clinic')).json<WebManifest>();
    const b = (await get('/manifest.webmanifest', 'boot-demo')).json<WebManifest>();

    expect(a.name).not.toBe(b.name);
    expect(a.theme_color).not.toBe(b.theme_color);
  });

  it('uses the product icons until the organization uploads a logo', async () => {
    const manifest = (await get('/manifest.webmanifest', 'boot-plain')).json<WebManifest>();

    expect(manifest.icons[0]?.src).toBe('/icons/icon-192.png');
    expect(manifest.icons[1]?.src).toBe('/icons/icon-512.png');
  });
});

describe('GET /public/branding/logo size variants', () => {
  it('answers 404 for an organization without a logo', async () => {
    const response = await get('/public/branding/logo?size=192', 'boot-plain');

    expect(response.statusCode).toBe(404);
  });
});
