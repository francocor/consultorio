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

/** Production needs a mail server with transport security. */
const mail = { SMTP_HOST: 'smtp.example.test', SMTP_SECURITY: 'starttls' };

const single = {
  DATABASE_URL,
  DEPLOYMENT_MODE: 'single',
  SINGLE_TENANT_SLUG: 'centro-norte',
  PUBLIC_URL: 'https://agenda.clinica.example',
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
      loadConfig({
        ...multi,
        NODE_ENV: 'production',
        ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
        KMS_PROVIDER: 'aws',
        ...aws,
        ...mail,
      }).cookieSecure,
    ).toBe(true);
  });

  it('refuses insecure cookies in production', () => {
    expect(() =>
      loadConfig({
        ...multi,
        NODE_ENV: 'production',
        ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
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

describe('proxy configuration (security review finding 2)', () => {
  const production = {
    ...multi,
    NODE_ENV: 'production',
    ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
    KMS_PROVIDER: 'aws',
    ...aws,
    ...mail,
  };

  it('does not trust proxies by default in development', () => {
    expect(loadConfig(multi).trustProxy).toBe(false);
  });

  it('trusts exactly one proxy by default in production (behind a single reverse proxy)', () => {
    expect(loadConfig(production).trustProxy).toBe(1);
  });

  it('lets production say that nothing is in front of the app', () => {
    expect(loadConfig({ ...production, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...production, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('takes the number of proxies in front of the app', () => {
    expect(loadConfig({ ...multi, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...multi, TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('takes a list of proxy addresses and ranges', () => {
    expect(loadConfig({ ...multi, TRUST_PROXY: '10.0.0.0/8, 192.168.1.5,::1' }).trustProxy).toEqual(
      ['10.0.0.0/8', '192.168.1.5', '::1'],
    );
  });

  it('refuses "true": it would trust every hop and let a client pick its own address', () => {
    expect(() => loadConfig({ ...multi, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it.each(['yes', '-1', '1.5', '99', '10.0.0.0/33', 'not-an-address', '10.0.0.1,,'])(
    'rejects the malformed value %j',
    (value) => {
      expect(() => loadConfig({ ...multi, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );
});

describe('public URL configuration (security review finding 1)', () => {
  it('single mode needs PUBLIC_URL: emailed links are never built from the Host header', () => {
    const rest = omit(single, 'PUBLIC_URL');

    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/PUBLIC_URL/);
  });

  it('keeps only the origin of PUBLIC_URL', () => {
    expect(loadConfig({ ...single, PUBLIC_URL: 'https://agenda.clinica.example' }).publicUrl).toBe(
      'https://agenda.clinica.example',
    );
  });

  it.each(['agenda.clinica.example', 'ftp://clinica.example', 'https://u:p@clinica.example'])(
    'rejects PUBLIC_URL %j',
    (value) => {
      expect(() => loadConfig({ ...single, PUBLIC_URL: value })).toThrow(/PUBLIC_URL/);
    },
  );

  it('requires https for PUBLIC_URL in production', () => {
    expect(() =>
      loadConfig({
        ...single,
        NODE_ENV: 'production',
        ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
        KMS_PROVIDER: 'aws',
        ...aws,
        ...mail,
        PUBLIC_URL: 'http://agenda.clinica.example',
      }),
    ).toThrow(/PUBLIC_URL/);
  });

  it('multi mode builds links from BASE_DOMAIN and does not need PUBLIC_URL', () => {
    expect(loadConfig(multi).publicUrl).toBeUndefined();
  });

  it('accepts a development port for the links of multi mode', () => {
    expect(loadConfig({ ...multi, PUBLIC_PORT: '5173' }).publicPort).toBe(5173);
    expect(() => loadConfig({ ...multi, PUBLIC_PORT: '70000' })).toThrow(/PUBLIC_PORT/);
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
    expect(() =>
      loadConfig({
        ...multi,
        NODE_ENV: 'production',
        ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
      }),
    ).toThrow(/KMS_PROVIDER/);
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

describe('audit sealer login', () => {
  it('is optional for the config (only the worker needs it) and kept as given', () => {
    const url = 'postgres://audit_sealer:placeholder@localhost:5432/app';

    expect(loadConfig(multi).auditSealerDatabaseUrl).toBeUndefined();
    expect(loadConfig({ ...multi, AUDIT_SEALER_DATABASE_URL: url }).auditSealerDatabaseUrl).toBe(
      url,
    );
  });

  it('rejects a value that is not a postgres URL, naming the variable', () => {
    expect(() => loadConfig({ ...multi, AUDIT_SEALER_DATABASE_URL: 'https://x.test' })).toThrow(
      /AUDIT_SEALER_DATABASE_URL/,
    );
  });
});
