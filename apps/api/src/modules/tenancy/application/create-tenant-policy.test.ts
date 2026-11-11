import { describe, expect, it } from 'vitest';

import { AppError } from '../../../platform/http/problem.js';
import type { DeploymentSettings } from '../domain/host.js';

import { assertCanCreateTenant } from './create-tenant-policy.js';

const MULTI: DeploymentSettings = {
  mode: 'multi',
  baseDomain: 'consultorio.test',
  platformHost: 'platform.consultorio.test',
};

describe('assertCanCreateTenant', () => {
  it('allows any number of tenants in multi mode', () => {
    expect(() => {
      assertCanCreateTenant(MULTI, 0);
    }).not.toThrow();
    expect(() => {
      assertCanCreateTenant(MULTI, 250);
    }).not.toThrow();
  });

  it('allows the first (and only) organization of a single-tenant instance', () => {
    expect(() => {
      assertCanCreateTenant({ mode: 'single', slug: 'centro' }, 0);
    }).not.toThrow();
  });

  it('refuses a second organization in single mode', () => {
    expect(() => {
      assertCanCreateTenant({ mode: 'single', slug: 'centro' }, 1);
    }).toThrow(AppError);
    expect(() => {
      assertCanCreateTenant({ mode: 'single', slug: 'centro' }, 3);
    }).toThrow(/forbidden/);
  });

  it('refuses a single-mode organization whose slug is not the configured one', () => {
    expect(() => {
      assertCanCreateTenant({ mode: 'single', slug: 'centro' }, 0, 'otro');
    }).toThrow(AppError);
    expect(() => {
      assertCanCreateTenant({ mode: 'single', slug: 'centro' }, 0, 'centro');
    }).not.toThrow();
  });
});
