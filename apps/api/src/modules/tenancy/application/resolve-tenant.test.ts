import { describe, expect, it, vi } from 'vitest';

import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import type { DeploymentSettings } from '../domain/host.js';

import { createResolveHost } from './resolve-tenant.js';

const NORTE: ResolvedTenant = {
  id: '0190a000-0000-7000-8000-00000000000a',
  slug: 'norte',
  status: 'active',
  readOnlySince: null,
  isDemo: false,
  country: 'AR',
};
const SUR: ResolvedTenant = { ...NORTE, id: '0190a000-0000-7000-8000-00000000000b', slug: 'sur' };

const multi: DeploymentSettings = {
  mode: 'multi',
  baseDomain: 'consultorio.test',
  platformHost: 'platform.consultorio.test',
};

function lookup() {
  const calls: string[] = [];
  const table = new Map([NORTE, SUR].map((tenant) => [tenant.slug, tenant]));
  const fn = vi.fn((slug: string) => {
    calls.push(slug);
    return Promise.resolve(table.get(slug) ?? null);
  });
  return { fn, calls };
}

describe('resolveHost', () => {
  it('resolves the tenant whose slug is the subdomain', async () => {
    const { fn } = lookup();
    const resolve = createResolveHost(multi, fn);

    expect(await resolve('norte.consultorio.test')).toEqual({ kind: 'tenant', tenant: NORTE });
    expect(await resolve('sur.consultorio.test:8080')).toEqual({ kind: 'tenant', tenant: SUR });
  });

  it('selects the operator context for the platform host without touching the database', async () => {
    const { fn, calls } = lookup();

    const context = await createResolveHost(multi, fn)('platform.consultorio.test');

    expect(context).toEqual({ kind: 'platform' });
    expect(calls).toEqual([]);
  });

  it('answers null for a well-formed host whose tenant does not exist', async () => {
    const { fn, calls } = lookup();

    expect(await createResolveHost(multi, fn)('ghost.consultorio.test')).toBeNull();
    expect(calls).toEqual(['ghost']);
  });

  it('answers null for an unknown host without touching the database', async () => {
    const { fn, calls } = lookup();

    expect(await createResolveHost(multi, fn)('evil.example.org')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('pins the configured tenant in single mode whatever the host says', async () => {
    const { fn, calls } = lookup();
    const resolve = createResolveHost({ mode: 'single', slug: 'sur' }, fn);

    expect(await resolve('norte.consultorio.test')).toEqual({ kind: 'tenant', tenant: SUR });
    expect(await resolve(undefined)).toEqual({ kind: 'tenant', tenant: SUR });
    expect(calls).toEqual(['sur', 'sur']);
  });
});
