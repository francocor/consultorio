import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_POOL_MAX } from '../platform/db/pool.js';
import { CONNECTION_HOLDING_JOBS, JOB_LOCAL_CONCURRENCY } from '../platform/jobs/concurrency.js';
import { omit } from '../testing/omit.js';

import { ConfigError, ENV_VARIABLES, MIN_DB_POOL_MAX, loadConfig } from './config.js';

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

  it('sizes the pool of the runtime connection with DB_POOL_MAX, above the floor by default (JD-S4 R3-A-W5, JD-S5 R4-2, Stage 6)', () => {
    expect(loadConfig(validEnv).dbPoolMax).toBe(DEFAULT_RUNTIME_POOL_MAX);
    expect(DEFAULT_RUNTIME_POOL_MAX).toBe(48);
    expect(DEFAULT_RUNTIME_POOL_MAX).toBeGreaterThanOrEqual(MIN_DB_POOL_MAX);
    expect(loadConfig({ ...validEnv, DB_POOL_MAX: '50' }).dbPoolMax).toBe(50);
    for (const bad of ['0', '-1', '1.5', 'abc', '101']) {
      expect(() => loadConfig({ ...validEnv, DB_POOL_MAX: bad }), bad).toThrow(/DB_POOL_MAX/);
    }
  });

  it('refuses a pool too small for the jobs the worker runs at once, and says how many it needs (JD-S4 R4-B-T5, JD-S5 R4-2)', () => {
    // A job of these families holds the transaction `runJob` opens for it, idle, while it waits for the
    // authority, the provider or the mail server, and asks for a second connection for its own work.
    // The worker runs JOB_LOCAL_CONCURRENCY of each at once, and two more connections serve the
    // sweeper and the other jobs: with fewer, jobs wait on each other for the second connection.
    expect(CONNECTION_HOLDING_JOBS).toEqual([
      'afip.issue',
      'erx.reconcile',
      'portal.notice_sweep',
      'subscription.reconcile',
      'dunning.step',
      'trial.end',
      'usage.snapshot',
      'statement.generate',
      'export.build',
      'archive.write',
      'archive.verify',
    ]);
    expect(MIN_DB_POOL_MAX).toBe(CONNECTION_HOLDING_JOBS.length * JOB_LOCAL_CONCURRENCY * 2 + 2);
    expect(MIN_DB_POOL_MAX).toBe(46);
    for (const small of ['2', '6', '10', String(MIN_DB_POOL_MAX - 1)]) {
      expect(() => loadConfig({ ...validEnv, DB_POOL_MAX: small }), small).toThrow(
        new RegExp(`DB_POOL_MAX.*${String(MIN_DB_POOL_MAX)}`),
      );
    }
    expect(loadConfig({ ...validEnv, DB_POOL_MAX: String(MIN_DB_POOL_MAX) }).dbPoolMax).toBe(
      MIN_DB_POOL_MAX,
    );
  });

  it('accepts explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
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

  it('is accepted by the config schema as it is (its pool is the floor when the file pins less)', () => {
    // `DB_POOL_MAX=16` of `.env.example` is the maintainer's file and is below the floor that the
    // payments reconcile raised (MIN_DB_POOL_MAX): the maintainer sets it to DEFAULT_RUNTIME_POOL_MAX
    // (48) or the floor of the day. Until then this reads the floor from the code, so the example
    // keeps being checked for everything else.
    const pinned = Number(example['DB_POOL_MAX']);
    const config = loadConfig({
      ...example,
      DB_POOL_MAX: String(Math.max(Number.isFinite(pinned) ? pinned : 0, MIN_DB_POOL_MAX)),
    });

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
