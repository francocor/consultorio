import { describe, expect, it } from 'vitest';

import {
  commandEnvironment,
  longRunningEnvironment,
  migrateEnvironment,
  MissingSlugError,
  osEnvironment,
  publicUrl,
  type RuntimeContext,
} from './api-env.js';
import { newInstallConfig } from './config-store.js';
import { resolveDataPaths } from './paths.js';
import { generateSecrets } from './secrets.js';

const paths = resolveDataPaths({
  env: { CONSULVIA_DATA_DIR: 'C:\\Datos\\Consulvia' },
  localAppData: 'C:\\Users\\Ana\\AppData\\Local',
  documents: 'C:\\Users\\Ana\\Documents',
});

function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const config = newInstallConfig(47800, generateSecrets());
  config.slug = 'consultorio';
  return { config, paths, databasePort: 54321, apiPort: 41000, serverPort: 47800, ...overrides };
}

describe('the environment of the API and the worker', () => {
  it('has the variables of the contract for the API, and nothing else of ours', () => {
    const { config } = context();
    const env = longRunningEnvironment('api', context({ config }));

    expect(env).toMatchObject({
      NODE_ENV: 'production',
      DEPLOYMENT_PROFILE: 'desktop',
      DEPLOYMENT_MODE: 'single',
      SINGLE_TENANT_SLUG: 'consultorio',
      PUBLIC_URL: 'http://127.0.0.1:47800',
      KMS_PROVIDER: 'local',
      KMS_LOCAL_KEK_BASE64: config.secrets.kmsLocalKekBase64,
      ADDRESS_HASH_PEPPER: config.secrets.addressHashPepper,
      STORAGE_DIR: paths.files,
      STORAGE_UPLOAD_SECRET: config.secrets.storageUploadSecret,
      OUTBOX_DIR: paths.outbox,
      PORT: '41000',
      HOST: '127.0.0.1',
    });
    expect(env['DATABASE_URL']).toBe(
      `postgres://app_rw:${config.secrets.appRwPassword}@127.0.0.1:54321/consultorio`,
    );
  });

  it('gives the audit-sealing login to the worker and NOT to the API', () => {
    const { config } = context();

    const api = longRunningEnvironment('api', context({ config }));
    const worker = longRunningEnvironment('worker', context({ config }));

    expect(api['AUDIT_SEALER_DATABASE_URL']).toBeUndefined();
    expect(worker['AUDIT_SEALER_DATABASE_URL']).toBe(
      `postgres://audit_sealer:${config.secrets.auditSealerPassword}@127.0.0.1:54321/consultorio`,
    );
    expect(worker['PORT']).toBeUndefined();
  });

  it('gives the secret of the run to the API, and to nothing else', () => {
    const secret = 'run-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

    expect(longRunningEnvironment('api', context({ proxySecret: secret }))).toMatchObject({
      DESKTOP_PROXY_SECRET: secret,
    });
    expect(
      longRunningEnvironment('worker', context({ proxySecret: secret }))['DESKTOP_PROXY_SECRET'],
    ).toBeUndefined();
    expect(
      commandEnvironment(context({ proxySecret: secret }))['DESKTOP_PROXY_SECRET'],
    ).toBeUndefined();
  });

  it('never sets the variables the desktop profile refuses', () => {
    const env = longRunningEnvironment('worker', context());

    for (const name of [
      'COOKIE_SECURE',
      'TRUST_PROXY',
      'SMTP_HOST',
      'BOT_CHALLENGE',
      'LOCAL_PROVIDERS_CONSOLE',
      'MIGRATION_DATABASE_URL',
      'RELEASER_DATABASE_URL',
      'OPERATOR_DATABASE_URL',
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(Object.keys(env).filter((name) => /_PROVIDER$|^ARCHIVE_|^S3_/.test(name))).toEqual([
      'KMS_PROVIDER',
    ]);
  });

  it('does not leak the environment of the shell into the child', () => {
    const env = longRunningEnvironment('api', context());

    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(Object.keys(env)).not.toContain('CONSULVIA_DATA_DIR');
  });

  it('encodes a password that is not URL-safe, so the URL always parses', () => {
    const config = newInstallConfig(47800, generateSecrets());
    config.slug = 'consultorio';
    config.secrets.appRwPassword = 'a/b?c#d@e:f';

    const url = new URL(longRunningEnvironment('api', context({ config }))['DATABASE_URL'] ?? '');

    expect(decodeURIComponent(url.password)).toBe('a/b?c#d@e:f');
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('needs the slug', () => {
    const config = newInstallConfig(47800, generateSecrets());

    expect(() => commandEnvironment(context({ config }))).toThrow(MissingSlugError);
  });
});

describe('the environment of the one-shot commands', () => {
  it('gives provision and reset-password the install variables, with no port and no sealer login', () => {
    const env = commandEnvironment(context());

    expect(env['DATABASE_URL']).toContain('app_rw:');
    expect(env['PORT']).toBeUndefined();
    expect(env['AUDIT_SEALER_DATABASE_URL']).toBeUndefined();
  });

  it('gives migrate the owner login and nothing about the installation', () => {
    const { config } = context();

    const env = migrateEnvironment({ config, databasePort: 54321 }, 'C:\\mig');

    expect(env['MIGRATION_DATABASE_URL']).toBe(
      `postgres://app_owner:${config.secrets.appOwnerPassword}@127.0.0.1:54321/consultorio`,
    );
    expect(env['MIGRATIONS_DIR']).toBe('C:\\mig');
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['KMS_LOCAL_KEK_BASE64']).toBeUndefined();
  });
});

describe('the Windows variables a child gets', () => {
  it('keeps the ones Windows needs, whatever their case, and drops the rest', () => {
    const env = osEnvironment({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      NODE_OPTIONS: '--inspect',
      GITHUB_TOKEN: 'secret',
    });

    expect(env).toEqual({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
    });
  });

  it('builds PUBLIC_URL from the port of the local server', () => {
    expect(publicUrl(47800)).toBe('http://127.0.0.1:47800');
  });
});
