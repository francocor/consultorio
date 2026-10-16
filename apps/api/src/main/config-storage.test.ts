import { describe, expect, it } from 'vitest';

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
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

describe('object storage configuration', () => {
  it('is absent when S3_BUCKET is not set (logo upload and documents are then unavailable)', () => {
    expect(loadConfig(base).storage).toBeUndefined();
  });

  it('reads the MinIO settings of local development', () => {
    const config = loadConfig({
      ...base,
      S3_BUCKET: 'consultorio-files',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY_ID: 'minio_dev',
      S3_SECRET_ACCESS_KEY: 'minio_dev_only_secret',
    });

    expect(config.storage).toEqual({
      bucket: 'consultorio-files',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'minio_dev', secretAccessKey: 'minio_dev_only_secret' },
    });
  });

  it('reads AWS S3 settings: the region of the deployment, the role credentials, no endpoint', () => {
    const config = loadConfig({ ...production, S3_BUCKET: 'consultorio-prod-files' });

    expect(config.storage).toEqual({
      bucket: 'consultorio-prod-files',
      region: 'sa-east-1',
      forcePathStyle: false,
    });
  });

  it('lets S3_REGION override the region', () => {
    const config = loadConfig({ ...base, S3_BUCKET: 'bucket-b', S3_REGION: 'eu-west-1' });

    expect(config.storage?.region).toBe('eu-west-1');
  });

  it('wants the access key and the secret together', () => {
    expect(() => loadConfig({ ...base, S3_BUCKET: 'bucket-b', S3_ACCESS_KEY_ID: 'x' })).toThrow(
      /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/,
    );
    expect(() => loadConfig({ ...base, S3_BUCKET: 'bucket-b', S3_SECRET_ACCESS_KEY: 'x' })).toThrow(
      ConfigError,
    );
  });

  it('refuses static keys in production: the task role is used', () => {
    expect(() =>
      loadConfig({
        ...production,
        S3_BUCKET: 'bucket-b',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        S3_SECRET_ACCESS_KEY: 'secret-value',
      }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('refuses an endpoint that is not an http(s) URL, and the bucket-less settings', () => {
    expect(() =>
      loadConfig({ ...base, S3_BUCKET: 'bucket-b', S3_ENDPOINT: 'localhost:9000' }),
    ).toThrow(/S3_ENDPOINT/);
    expect(() => loadConfig({ ...base, S3_ENDPOINT: 'http://localhost:9000' })).toThrow(
      /S3_BUCKET/,
    );
  });

  it('never prints a secret when it refuses a configuration', () => {
    try {
      loadConfig({ ...base, S3_BUCKET: 'bucket-b', S3_ACCESS_KEY_ID: 'visible-key-id' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('visible-key-id');
    }
  });
});
