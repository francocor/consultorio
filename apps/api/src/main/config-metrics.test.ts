import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { METRICS_ENV_VARIABLES } from './config-metrics.js';
import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

const TOKEN = 'a-scraper-token-0123456789-abcdef';

describe('metrics configuration', () => {
  it('is off unless a port is given: nothing listens by default', () => {
    expect(loadConfig(base).metrics).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_HOST: '127.0.0.1' }).metrics).toBeUndefined();
  });

  it('listens on the loopback interface by default, with no token', () => {
    expect(loadConfig({ ...base, METRICS_PORT: '9464' }).metrics).toEqual({
      host: '127.0.0.1',
      port: 9464,
    });
    expect(
      loadConfig({ ...base, METRICS_PORT: '9464', METRICS_HOST: 'localhost' }).metrics,
    ).toEqual({ host: 'localhost', port: 9464 });
  });

  it('wants a token as soon as the port is reachable from outside the machine', () => {
    expect(() => loadConfig({ ...base, METRICS_PORT: '9464', METRICS_HOST: '0.0.0.0' })).toThrow(
      /METRICS_TOKEN/,
    );
    expect(
      loadConfig({
        ...base,
        METRICS_PORT: '9464',
        METRICS_HOST: '0.0.0.0',
        METRICS_TOKEN: TOKEN,
      }).metrics,
    ).toEqual({ host: '0.0.0.0', port: 9464, token: TOKEN });
  });

  it('takes a token on the loopback interface too, and refuses a short one', () => {
    expect(loadConfig({ ...base, METRICS_PORT: '9464', METRICS_TOKEN: TOKEN }).metrics?.token).toBe(
      TOKEN,
    );
    expect(() => loadConfig({ ...base, METRICS_PORT: '9464', METRICS_TOKEN: 'short' })).toThrow(
      /METRICS_TOKEN/,
    );
  });

  it('refuses a bad port or host, naming the variable and never the value', () => {
    expect(() => loadConfig({ ...base, METRICS_PORT: '70000' })).toThrow(/METRICS_PORT/);
    expect(() => loadConfig({ ...base, METRICS_PORT: 'x' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, METRICS_PORT: '9464', METRICS_HOST: 'not a host!' }),
    ).toThrow(/METRICS_HOST/);
    try {
      loadConfig({ ...base, METRICS_PORT: '9464', METRICS_TOKEN: 'secret-short' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-short');
    }
  });

  it('is written down for whoever deploys: every variable appears in the developer guide', () => {
    const guide = readFileSync(new URL('../../../../docs/dev-setup.md', import.meta.url), 'utf8');

    for (const name of METRICS_ENV_VARIABLES) expect(guide, name).toContain(name);
  });
});
