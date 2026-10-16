import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { deploymentFromConfig } from './deployment.js';

const base = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 3).toString('base64'),
};

describe('deploymentFromConfig', () => {
  it('maps multi mode to the base domain and the platform host', () => {
    const config = loadConfig({
      ...base,
      DEPLOYMENT_MODE: 'multi',
      BASE_DOMAIN: 'consultorio.test',
      PLATFORM_HOST: 'platform.consultorio.test',
    });

    expect(deploymentFromConfig(config)).toEqual({
      mode: 'multi',
      baseDomain: 'consultorio.test',
      platformHost: 'platform.consultorio.test',
    });
  });

  it('maps single mode to the pinned slug and ignores any domain', () => {
    const config = loadConfig({
      ...base,
      DEPLOYMENT_MODE: 'single',
      SINGLE_TENANT_SLUG: 'centro-norte',
      PUBLIC_URL: 'https://agenda.centro-norte.example',
      BASE_DOMAIN: 'consultorio.test',
    });

    expect(deploymentFromConfig(config)).toEqual({ mode: 'single', slug: 'centro-norte' });
  });
});
