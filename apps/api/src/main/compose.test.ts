import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const compose = readFileSync(
  new URL('../../../../infra/docker-compose.yml', import.meta.url),
  'utf8',
);

/**
 * Security review finding 9: the compose file carries public throwaway credentials and the local
 * key-encryption key. It must say so before anything else, and must never run the application as
 * production (which would be the way those values reach real data).
 */
describe('infra/docker-compose.yml', () => {
  it('opens with a loud development-only warning, before any service', () => {
    const header = compose.slice(0, compose.indexOf('services:'));

    expect(header).toMatch(/DEVELOPMENT ONLY/);
    expect(header).toMatch(/DO NOT DEPLOY/);
  });

  it('runs the application image as development, where the local key is allowed', () => {
    expect(compose).toMatch(/NODE_ENV:\s*development/);
    expect(compose).not.toMatch(/NODE_ENV:\s*production/);
  });

  it('gives every credential default a visibly throwaway value', () => {
    const defaults = [
      ...compose.matchAll(/^\s*(\w*(?:PASSWORD|SECRET)\w*):\s*\$\{[A-Z_]+:-([^}\n]*)\}/gm),
    ];

    expect(defaults.length).toBeGreaterThan(0);
    for (const [, name, value] of defaults) {
      expect(value, name).toMatch(/dev_only/);
    }
  });
});
