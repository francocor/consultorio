import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SCANNER_ENV_VARIABLES } from './config-scanner.js';
import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

const production = {
  ...base,
  NODE_ENV: 'production',
  ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

describe('malware scanner configuration', () => {
  it('is absent when CLAMAV_HOST is not set (development then uses the fake scanner)', () => {
    expect(loadConfig(base).scanner).toBeUndefined();
    expect(loadConfig({ ...base, S3_BUCKET: 'consultorio-files' }).scanner).toBeUndefined();
  });

  it('ignores a port without a host: the compose file reads CLAMAV_PORT too, to publish the container', () => {
    expect(loadConfig({ ...base, CLAMAV_PORT: '3310' }).scanner).toBeUndefined();
  });

  it('reads the host and defaults the port to the one clamd uses', () => {
    expect(loadConfig({ ...base, CLAMAV_HOST: 'localhost' }).scanner).toEqual({
      host: 'localhost',
      port: 3310,
    });
    expect(loadConfig({ ...base, CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3311' }).scanner).toEqual({
      host: 'clamav',
      port: 3311,
    });
  });

  it('refuses a bad host or port, naming the variable and not the value', () => {
    expect(() => loadConfig({ ...base, CLAMAV_HOST: 'not a host!' })).toThrow(/CLAMAV_HOST/);
    expect(() => loadConfig({ ...base, CLAMAV_HOST: 'clamav', CLAMAV_PORT: '99999' })).toThrow(
      /CLAMAV_PORT/,
    );
    expect(() => loadConfig({ ...base, CLAMAV_HOST: 'clamav', CLAMAV_PORT: 'x' })).toThrow(
      ConfigError,
    );
    try {
      loadConfig({ ...base, CLAMAV_HOST: 'very secret host!' });
    } catch (error) {
      expect((error as Error).message).not.toContain('very secret');
    }
  });

  it('is required in production once documents have somewhere to be stored: no scanner, no uploads', () => {
    expect(() => loadConfig({ ...production, S3_BUCKET: 'consultorio-prod-files' })).toThrow(
      /CLAMAV_HOST/,
    );
    expect(
      loadConfig({ ...production, S3_BUCKET: 'consultorio-prod-files', CLAMAV_HOST: 'clamav' })
        .scanner?.host,
    ).toBe('clamav');
    // Without a bucket there are no documents, so there is nothing to scan.
    expect(loadConfig(production).scanner).toBeUndefined();
  });

  it('is written down for whoever deploys: every variable appears in the developer guide', () => {
    const guide = readFileSync(new URL('../../../../docs/dev-setup.md', import.meta.url), 'utf8');

    for (const name of SCANNER_ENV_VARIABLES) expect(guide, name).toContain(name);
  });
});
