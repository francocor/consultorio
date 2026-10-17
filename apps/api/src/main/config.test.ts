import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { omit } from '../testing/omit.js';

import { ConfigError, ENV_VARIABLES, loadConfig } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'localhost',
  PLATFORM_HOST: 'platform.localhost',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      nodeEnv: 'development',
      deploymentMode: 'multi',
      logLevel: 'info',
      host: '0.0.0.0',
      port: 3000,
      databaseUrl: validEnv.DATABASE_URL,
    });
  });

  it('accepts explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'single',
      SINGLE_TENANT_SLUG: 'centro',
      PUBLIC_URL: 'https://agenda.centro.example',
      KMS_PROVIDER: 'aws',
      AWS_REGION: 'sa-east-1',
      AWS_KMS_KEY_ID: 'alias/test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_SECURITY: 'starttls',
      LOG_LEVEL: 'warn',
      PORT: '8080',
    });

    expect(config).toMatchObject({
      nodeEnv: 'production',
      deploymentMode: 'single',
      logLevel: 'warn',
      port: 8080,
    });
  });

  it('fails to start when DATABASE_URL is missing', () => {
    const rest = omit(validEnv, 'DATABASE_URL');

    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('fails on an unknown deployment mode', () => {
    expect(() => loadConfig({ ...validEnv, DEPLOYMENT_MODE: 'hybrid' })).toThrow(/DEPLOYMENT_MODE/);
  });

  it('never prints secret values in the startup error', () => {
    const secretUrl = 'mysql://admin:topsecret-password@db.internal:3306/app';

    let message = '';
    try {
      loadConfig({ ...validEnv, DATABASE_URL: secretUrl, PORT: 'not-a-port-secret' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('PORT');
    expect(message).not.toContain('topsecret-password');
    expect(message).not.toContain('admin');
    expect(message).not.toContain('not-a-port-secret');
  });
});

describe('.env.example', () => {
  const example = parseEnv(
    readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
  );

  it('is accepted by the config schema as it is', () => {
    const config = loadConfig(example);

    expect(config.deploymentMode).toBe('multi');
    expect(config.databaseUrl).toContain('app_rw');
  });

  it('documents every variable the application reads', () => {
    expect(Object.keys(example)).toEqual(expect.arrayContaining([...ENV_VARIABLES]));
  });

  it('contains placeholders only: no value looks like a real credential', () => {
    for (const [name, value] of Object.entries(example)) {
      if (/PASSWORD|SECRET|DATABASE_URL/.test(name)) {
        expect(value, name).toMatch(/dev_only|placeholder|^$/);
      }
    }
  });
});
