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

  /** The text of one service: from its name to the next top-level entry of `services:`. */
  const serviceOf = (name: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    if (start === -1) return '';
    const next = /\n {2}[a-z][a-z-]*:\n|\nconfigs:\n|\nvolumes:\n/.exec(
      compose.slice(start + name.length + 4),
    );
    return compose.slice(start, next ? start + name.length + 4 + next.index : undefined);
  };

  it('keeps Prometheus and Grafana in a profile of their own, bound to the loopback interface', () => {
    const prometheus = serviceOf('prometheus');
    const grafana = serviceOf('grafana');

    expect(prometheus).toMatch(/profiles:\s*\['observability'\]/);
    expect(grafana).toMatch(/profiles:\s*\['observability'\]/);
    expect(prometheus).toContain("'127.0.0.1:${PROMETHEUS_PORT:-9090}:9090'");
    expect(grafana).toContain("'127.0.0.1:${GRAFANA_PORT:-3001}:3000'");
    // The rules that Prometheus loads are the ones of the repository, mounted read-only.
    expect(prometheus).toContain('./alerts:/etc/prometheus/alerts:ro');
    expect(grafana).toContain(
      'GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-grafana_dev_only}',
    );
  });

  it('gives the API service a metrics port that answers only to a token', () => {
    const api = serviceOf('api');

    expect(api).toMatch(/METRICS_PORT:\s*9464/);
    expect(api).toMatch(/METRICS_HOST:\s*0\.0\.0\.0/);
    expect(api).toMatch(/METRICS_TOKEN:\s*\$\{METRICS_TOKEN:-metrics_token_dev_only_\d+\}/);
  });
});
