import { Writable } from 'node:stream';

import { HealthResponse } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';

function testServer(checkDatabase: () => Promise<boolean>, logStream?: Writable) {
  return buildServer({
    logLevel: logStream ? 'info' : 'silent',
    ...(logStream ? { logStream } : {}),
    health: { checkDatabase },
  });
}

describe('health routes', () => {
  it('GET /health answers 200 without touching the database', async () => {
    let probed = false;
    const app = testServer(() => {
      probed = true;
      return Promise.resolve(true);
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'ok' });
    expect(probed).toBe(false);
    await app.close();
  });

  it('GET /ready answers 200 when the database probe succeeds', async () => {
    const app = testServer(() => Promise.resolve(true));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /ready answers 503 when the database probe reports down', async () => {
    const app = testServer(() => Promise.resolve(false));

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
});

describe('logging', () => {
  it('redacts credentials, cookies and bodies', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = testServer(() => Promise.resolve(true), stream);
    await app.ready();

    app.log.info({
      req: { headers: { authorization: 'Bearer very-secret-token', cookie: 'sid=very-secret' } },
      body: { diagnosis: 'very-secret-diagnosis' },
    });
    await app.close();

    const output = lines.join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('very-secret');
  });
});
