import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import type { DeploymentSettings } from '../../modules/tenancy/domain/host.js';
import { TEST_TENANT } from '../../testing/tenancy.js';

import type { ResolvedTenant } from './tenant-host.js';

const NORTE: ResolvedTenant = {
  ...TEST_TENANT,
  id: '0190a000-0000-7000-8000-0000000000a1',
  slug: 'norte',
};
const SUR: ResolvedTenant = {
  ...TEST_TENANT,
  id: '0190a000-0000-7000-8000-0000000000a2',
  slug: 'sur',
};

const multi: DeploymentSettings = {
  mode: 'multi',
  baseDomain: 'consultorio.test',
  platformHost: 'platform.consultorio.test',
};

function server(deployment: DeploymentSettings = multi) {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    deployment,
    lookupTenant: (slug) =>
      Promise.resolve([NORTE, SUR].find((tenant) => tenant.slug === slug) ?? null),
  });
  app.get('/whoami', { config: { readOnly: 'read' } }, (request) => request.hostContext);
  app.post('/webhooks/provider', { config: { readOnly: 'webhook' } }, () => ({ received: true }));
  return app;
}

describe('tenant host guard (multi mode)', () => {
  it('attaches the tenant of the subdomain to the request', async () => {
    const app = server();

    const norte = await app.inject({ url: '/whoami', headers: { host: 'norte.consultorio.test' } });
    const sur = await app.inject({ url: '/whoami', headers: { host: 'sur.consultorio.test' } });

    expect(norte.json<{ kind: string; tenant: { id: string } }>()).toMatchObject({
      kind: 'tenant',
      tenant: { id: NORTE.id },
    });
    expect(sur.json<{ tenant: { id: string } }>().tenant.id).toBe(SUR.id);
    await app.close();
  });

  it('selects the operator context on the platform host', async () => {
    const app = server();

    const response = await app.inject({
      url: '/whoami',
      headers: { host: 'platform.consultorio.test' },
    });

    expect(response.json()).toEqual({ kind: 'platform' });
    await app.close();
  });

  it('answers an unknown host and a missing tenant with the same generic 404 as an unknown route', async () => {
    const app = server();

    const unknownHost = await app.inject({ url: '/whoami', headers: { host: 'evil.example.org' } });
    const missingTenant = await app.inject({
      url: '/whoami',
      headers: { host: 'ghost.consultorio.test' },
    });
    const unknownRoute = await app.inject({
      url: '/no-such-route',
      headers: { host: 'norte.consultorio.test' },
    });

    for (const response of [unknownHost, missingTenant, unknownRoute]) {
      expect(response.statusCode).toBe(404);
      expect(Problem.parse(response.json())).toMatchObject({ code: 'not_found', status: 404 });
    }
    const shape = (body: Problem) => ({ ...body, requestId: undefined });
    expect(shape(Problem.parse(unknownHost.json()))).toEqual(
      shape(Problem.parse(missingTenant.json())),
    );
    expect(shape(Problem.parse(unknownHost.json()))).toEqual(
      shape(Problem.parse(unknownRoute.json())),
    );
    await app.close();
  });

  it('ignores an X-Tenant-Id header and a tenantId query: the host decides', async () => {
    const app = server();

    const response = await app.inject({
      url: `/whoami?tenantId=${SUR.id}`,
      headers: { host: 'norte.consultorio.test', 'x-tenant-id': SUR.id, 'x-tenant': 'sur' },
    });

    expect(response.json<{ tenant: { id: string } }>().tenant.id).toBe(NORTE.id);
    await app.close();
  });

  it('does not let a header rescue a request to an unknown host', async () => {
    const app = server();

    const response = await app.inject({
      url: '/whoami',
      headers: { host: 'evil.example.org', 'x-tenant-id': NORTE.id },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.each(['/health', '/ready'])('lets %s answer on any host (load balancers)', async (url) => {
    const app = server();

    const response = await app.inject({ url, headers: { host: '10.0.0.7:3000' } });

    expect(response.statusCode).not.toBe(404);
    await app.close();
  });

  it('lets provider webhooks through on any host', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/provider',
      headers: { host: 'unknown.example.org' },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('tenant host guard (single mode)', () => {
  it('pins the configured tenant for every host and ignores spoofed headers', async () => {
    const app = server({ mode: 'single', slug: 'sur' });

    const response = await app.inject({
      url: '/whoami',
      headers: { host: 'norte.consultorio.test', 'x-tenant-id': NORTE.id },
    });

    expect(response.json<{ tenant: { id: string } }>().tenant.id).toBe(SUR.id);
    await app.close();
  });

  it('answers 404 when the pinned tenant does not exist', async () => {
    const app = server({ mode: 'single', slug: 'not-created-yet' });

    const response = await app.inject({ url: '/whoami' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
