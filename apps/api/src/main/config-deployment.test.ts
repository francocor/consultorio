import { describe, expect, it } from 'vitest';

import { omit } from '../testing/omit.js';

import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app_rw:placeholder@localhost:5432/app';
const LOCAL_KEK = Buffer.alloc(32, 7).toString('base64');

const multi = {
  DATABASE_URL,
  DEPLOYMENT_MODE: 'multi',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: LOCAL_KEK,
};

const aws = { AWS_REGION: 'sa-east-1', AWS_KMS_KEY_ID: 'alias/consultorio-tenant-kek' };

const single = {
  DATABASE_URL,
  DEPLOYMENT_MODE: 'single',
  SINGLE_TENANT_SLUG: 'centro-norte',
  KMS_LOCAL_KEK_BASE64: LOCAL_KEK,
};

describe('deployment mode configuration', () => {
  it('multi mode needs BASE_DOMAIN and PLATFORM_HOST', () => {
    const config = loadConfig(multi);

    expect(config).toMatchObject({
      deploymentMode: 'multi',
      baseDomain: 'consultorio.test',
      platformHost: 'platform.consultorio.test',
    });
    expect(config.singleTenantSlug).toBeUndefined();
  });

  it('multi mode without BASE_DOMAIN fails to start and names the variable', () => {
    const rest = omit(multi, 'BASE_DOMAIN');

    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/BASE_DOMAIN/);
  });

  it('multi mode without PLATFORM_HOST fails to start', () => {
    const rest = omit(multi, 'PLATFORM_HOST');

    expect(() => loadConfig(rest)).toThrow(/PLATFORM_HOST/);
  });

  it('single mode pins the tenant slug', () => {
    const config = loadConfig(single);

    expect(config).toMatchObject({ deploymentMode: 'single', singleTenantSlug: 'centro-norte' });
  });

  it('single mode without SINGLE_TENANT_SLUG fails to start', () => {
    const rest = omit(single, 'SINGLE_TENANT_SLUG');

    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/SINGLE_TENANT_SLUG/);
  });

  it.each(['Centro Norte', 'UPPER', '-leading', 'trailing-', 'a', 'x'.repeat(64)])(
    'rejects the malformed slug %j',
    (slug) => {
      expect(() => loadConfig({ ...single, SINGLE_TENANT_SLUG: slug })).toThrow(
        /SINGLE_TENANT_SLUG/,
      );
    },
  );

  it('rejects a BASE_DOMAIN that carries a scheme, a port or a path', () => {
    for (const value of ['https://consultorio.test', 'consultorio.test:3000', 'a.test/x']) {
      expect(() => loadConfig({ ...multi, BASE_DOMAIN: value })).toThrow(/BASE_DOMAIN/);
    }
  });
});

describe('cookie configuration', () => {
  it('is not secure by default in development, so http://localhost works', () => {
    expect(loadConfig(multi).cookieSecure).toBe(false);
  });

  it('is secure by default in production', () => {
    expect(
      loadConfig({ ...multi, NODE_ENV: 'production', KMS_PROVIDER: 'aws', ...aws }).cookieSecure,
    ).toBe(true);
  });

  it('refuses insecure cookies in production', () => {
    expect(() =>
      loadConfig({
        ...multi,
        NODE_ENV: 'production',
        KMS_PROVIDER: 'aws',
        ...aws,
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('allows forcing secure cookies outside production', () => {
    expect(loadConfig({ ...multi, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });
});

describe('key management configuration', () => {
  it('uses the local key-encryption key by default (development and tests)', () => {
    expect(loadConfig(multi).kms).toEqual({ provider: 'local', kekBase64: LOCAL_KEK });
  });

  it('fails when the local KEK is missing', () => {
    const rest = omit(multi, 'KMS_LOCAL_KEK_BASE64');

    expect(() => loadConfig(rest)).toThrow(/KMS_LOCAL_KEK_BASE64/);
  });

  it('fails when the local KEK is not 32 bytes of base64', () => {
    expect(() => loadConfig({ ...multi, KMS_LOCAL_KEK_BASE64: 'c2hvcnQ=' })).toThrow(
      /KMS_LOCAL_KEK_BASE64/,
    );
  });

  it('selects AWS KMS with a region and a key id', () => {
    const rest = omit(multi, 'KMS_LOCAL_KEK_BASE64');

    expect(loadConfig({ ...rest, KMS_PROVIDER: 'aws', ...aws }).kms).toEqual({
      provider: 'aws',
      region: 'sa-east-1',
      keyId: 'alias/consultorio-tenant-kek',
    });
  });

  it('fails when AWS KMS is selected without a key id', () => {
    const rest = omit(multi, 'KMS_LOCAL_KEK_BASE64');

    expect(() => loadConfig({ ...rest, KMS_PROVIDER: 'aws', AWS_REGION: 'sa-east-1' })).toThrow(
      /AWS_KMS_KEY_ID/,
    );
  });

  it('refuses the local KEK in production (the key would sit next to the data)', () => {
    expect(() => loadConfig({ ...multi, NODE_ENV: 'production' })).toThrow(/KMS_PROVIDER/);
  });

  it('never prints the KEK in a startup error', () => {
    let message = '';
    try {
      loadConfig({ ...multi, BASE_DOMAIN: 'https://bad', KMS_LOCAL_KEK_BASE64: LOCAL_KEK });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('BASE_DOMAIN');
    expect(message).not.toContain(LOCAL_KEK);
  });
});
