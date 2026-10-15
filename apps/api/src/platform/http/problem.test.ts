import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { captureLogs } from '../../testing/log-capture.js';

import { PROBLEM_CONTENT_TYPE, type ProblemBody } from './problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEAKY_MESSAGE = 'relation "patient" failed for postgres://user:s3cret@db/clinic';

function serverWithFailingRoutes(logStream?: ReturnType<typeof captureLogs>['stream']) {
  const app = buildServer({
    logLevel: logStream ? 'info' : 'silent',
    ...(logStream ? { logStream } : {}),
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
  });
  app.get('/boom', () => {
    throw new Error(LEAKY_MESSAGE);
  });
  app.get('/conflict', () => {
    throw Object.assign(new Error(LEAKY_MESSAGE), { statusCode: 409 });
  });
  return app;
}

describe('problem+json handlers', () => {
  it('answers unknown routes with a 404 problem carrying the request id', async () => {
    const app = serverWithFailingRoutes();

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const body = response.json<ProblemBody>();
    expect(body).toMatchObject({ type: 'about:blank', title: 'Not Found', status: 404 });
    expect(body.requestId).toMatch(UUID);
    await app.close();
  });

  it('answers an unexpected error with a generic 500 and never leaks the message', async () => {
    const app = serverWithFailingRoutes();

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json<ProblemBody>()).toMatchObject({
      title: 'Internal Server Error',
      status: 500,
    });
    expect(response.body).not.toContain('s3cret');
    expect(response.body).not.toContain('relation');
    expect(response.body).not.toContain('at ');
    await app.close();
  });

  it('keeps the status of client errors but never echoes their message', async () => {
    const app = serverWithFailingRoutes();

    const response = await app.inject({ method: 'GET', url: '/conflict' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ProblemBody>()).toMatchObject({ title: 'Conflict', status: 409 });
    expect(response.body).not.toContain('s3cret');
    await app.close();
  });

  it('logs the failure without the error message', async () => {
    const logs = captureLogs();
    const app = serverWithFailingRoutes(logs.stream);

    await app.inject({ method: 'GET', url: '/boom' });
    await app.close();

    const failure = logs.lines().find((line) => line['msg'] === 'request failed');
    expect(failure).toMatchObject({ level: 50, failure: { name: 'Error' } });
    expect(logs.raw()).not.toContain('s3cret');
  });
});
