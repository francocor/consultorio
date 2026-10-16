import { describe, expect, it } from 'vitest';

import { classifyHost, type DeploymentSettings } from './host.js';

const multi: DeploymentSettings = {
  mode: 'multi',
  baseDomain: 'consultorio.test',
  platformHost: 'platform.consultorio.test',
};
const single: DeploymentSettings = { mode: 'single', slug: 'centro-norte' };

describe('classifyHost in multi mode', () => {
  it.each([
    ['norte.consultorio.test', { kind: 'tenant', slug: 'norte' }],
    ['norte.consultorio.test:3000', { kind: 'tenant', slug: 'norte' }],
    ['NORTE.Consultorio.TEST', { kind: 'tenant', slug: 'norte' }],
    ['centro-sur-2.consultorio.test.', { kind: 'tenant', slug: 'centro-sur-2' }],
    ['platform.consultorio.test', { kind: 'platform' }],
    ['PLATFORM.consultorio.test:443', { kind: 'platform' }],
  ])('maps %s to %j', (host, expected) => {
    expect(classifyHost(host, multi)).toEqual(expected);
  });

  it.each([
    ['the bare base domain', 'consultorio.test'],
    ['a nested subdomain', 'a.norte.consultorio.test'],
    ['another domain', 'norte.evil.test'],
    ['a look-alike suffix', 'norteconsultorio.test'],
    ['a domain that only ends like the base', 'norte.xconsultorio.test'],
    ['an IP address', '127.0.0.1:3000'],
    ['an IPv6 literal', '[::1]:3000'],
    ['a label that is not a valid slug', '-bad.consultorio.test'],
    ['an uppercase-only invalid character', 'no_good.consultorio.test'],
    ['an empty label', '.consultorio.test'],
    ['an empty host', ''],
    ['a missing host', undefined],
    ['a host with a path', 'norte.consultorio.test/admin'],
    ['a host with credentials', 'user@norte.consultorio.test'],
    ['a host with a space', 'norte .consultorio.test'],
  ])('treats %s as unknown', (_label, host) => {
    expect(classifyHost(host, multi)).toEqual({ kind: 'unknown' });
  });
});

describe('classifyHost in single mode', () => {
  it.each(['anything.example.org', 'localhost:3000', '10.0.0.4', 'centro-norte.consultorio.test'])(
    'pins every host (%s) to the configured tenant',
    (host) => {
      expect(classifyHost(host, single)).toEqual({ kind: 'tenant', slug: 'centro-norte' });
    },
  );

  it('pins even when no host header is sent', () => {
    expect(classifyHost(undefined, single)).toEqual({ kind: 'tenant', slug: 'centro-norte' });
  });
});
