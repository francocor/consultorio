import type { Writable } from 'node:stream';

import { HealthResponse } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { captureLogs } from '../../testing/log-capture.js';
import { testTenancy } from '../../testing/tenancy.js';
import type { DbCheckResult } from '../db/probe.js';

function testServer(checkDatabase: () => Promise<DbCheckResult>, logStream?: Writable) {
  return buildServer({
    logLevel: logStream ? 'info' : 'silent',
    ...(logStream ? { logStream } : {}),
    health: { checkDatabase },
    ...testTenancy(),
  });
}

const up = () => Promise.resolve<DbCheckResult>({ ok: true });
const down =
  (code = 'ECONNREFUSED') =>
  () =>
    Promise.resolve<DbCheckResult>({ ok: false, code });

describe('health routes', () => {
  it('GET /health answers 200 without touching the database', async () => {
    let probed = false;
    const app = testServer(() => {
      probed = true;
      return up();
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'ok' });
    expect(probed).toBe(false);
    await app.close();
  });

  it('GET /ready answers 200 when the database probe succeeds', async () => {
    const app = testServer(up);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /ready answers 503 when the database probe reports down', async () => {
    const app = testServer(down());

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'unavailable' });
    await app.close();
  });

  it('GET /ready answers 503 when the database probe throws', async () => {
    const app = testServer(() => Promise.reject(new Error('connection refused')));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('connection refused');
    await app.close();
  });

  it('GET /ready logs a warning with only the error code when the database is down', async () => {
    const logs = captureLogs();
    const app = testServer(down('ECONNREFUSED'), logs.stream);

    await app.inject({ method: 'GET', url: '/ready' });
    await app.close();

    const warning = logs.lines().find((line) => line['level'] === 40);
    expect(warning).toMatchObject({ code: 'ECONNREFUSED' });
    expect(warning).not.toHaveProperty('err');
  });

  it('GET /ready never logs the message of a thrown probe error', async () => {
    const logs = captureLogs();
    const app = testServer(
      () => Promise.reject(new Error('password authentication failed for user "secret-user"')),
      logs.stream,
    );

    await app.inject({ method: 'GET', url: '/ready' });
    await app.close();

    expect(logs.raw()).not.toContain('secret-user');
    expect(logs.lines().find((line) => line['level'] === 40)).toMatchObject({ code: 'unknown' });
  });
});
