import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildServer } from '../../main/server.js';
import { testTenancy } from '../../testing/tenancy.js';

import { AppError, denied, forbidden } from './problem.js';

function server() {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
  });
  app.get('/read-only', { config: { readOnly: 'read' } }, () => {
    throw new AppError('tenant_read_only');
  });
  app.get('/missing', { config: { readOnly: 'read' } }, (request, reply) => denied(request, reply));
  app.get('/not-allowed', { config: { readOnly: 'read' } }, (request, reply) =>
    forbidden(request, reply),
  );
  app.get('/not-yours', { config: { readOnly: 'read' } }, (request, reply) =>
    denied(request, reply),
  );
  app.get('/rejected-fields', { config: { readOnly: 'read' } }, () => {
    throw new AppError('validation_failed', [
      { path: 'password', i18nKey: 'auth.password.common' },
      { path: 'password', i18nKey: 'auth.password.too_short' },
    ]);
  });
  app.post(
    '/validated',
    {
      config: { readOnly: 'write' },
      schema: { body: z.object({ name: z.string().min(3), age: z.number().int() }) },
    },
    () => ({ ok: true }),
  );
  return app;
}

function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'));
}

describe('problem+json carries a catalogued code', () => {
  it('sends an unknown route as a contract-valid not_found problem', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/nope' });
    const body = Problem.parse(response.json());

    expect(response.statusCode).toBe(404);
    expect(body).toMatchObject({ code: 'not_found', i18nKey: 'errors.not_found' });
    await app.close();
  });

  it('maps an AppError to the status and code of the catalog', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/read-only' });

    expect(response.statusCode).toBe(402);
    expect(Problem.parse(response.json())).toMatchObject({
      code: 'tenant_read_only',
      i18nKey: 'errors.tenant_read_only',
      status: 402,
    });
    await app.close();
  });

  it('sends an unexpected error as internal_error without internals', async () => {
    const app = server();
    app.get('/crash', { config: { readOnly: 'read' } }, () => {
      throw new Error('select * from patient where dni = 30123456');
    });

    const response = await app.inject({ method: 'GET', url: '/crash' });

    expect(response.statusCode).toBe(500);
    expect(Problem.parse(response.json())).toMatchObject({ code: 'internal_error' });
    expect(response.body).not.toContain('patient');
    expect(response.body).not.toContain('30123456');
    await app.close();
  });

  it('reports a failed validation as field paths and never echoes the submitted value', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: { name: 'ab', age: 'secret-age-value' },
    });
    const body = Problem.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(body.code).toBe('validation_failed');
    expect(body.errors?.map((error) => error.path).sort()).toEqual(['age', 'name']);
    expect(response.body).not.toContain('secret-age-value');
    await app.close();
  });
});

describe('request id', () => {
  it('is returned in the x-request-id header and equals the body requestId', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.headers['x-request-id']).toBe(response.json<{ requestId: string }>().requestId);
    await app.close();
  });

  it('is set on successful responses too', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('ignores a request id supplied by the client (no log injection)', async () => {
    const app = server();

    const response = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'attacker\nforged-log-line' },
    });

    expect(response.headers['x-request-id']).not.toContain('attacker');
    await app.close();
  });
});

describe('uniform denial', () => {
  it('answers a missing resource and a forbidden one with identical bodies', async () => {
    const app = server();

    const missing = await app.inject({ method: 'GET', url: '/missing' });
    const notYours = await app.inject({ method: 'GET', url: '/not-yours' });

    expect(missing.statusCode).toBe(404);
    expect(notYours.statusCode).toBe(404);
    expect(withoutRequestId(missing.json())).toEqual(withoutRequestId(notYours.json()));
    expect(missing.json<{ requestId: string }>().requestId).not.toBe(
      notYours.json<{ requestId: string }>().requestId,
    );
    expect(Problem.parse(missing.json())).toMatchObject({ code: 'not_found' });
    await app.close();
  });

  it('sends a capability-level denial as 403 forbidden with no resource detail', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/not-allowed' });

    expect(response.statusCode).toBe(403);
    expect(Problem.parse(response.json())).toMatchObject({
      code: 'forbidden',
      i18nKey: 'errors.forbidden',
    });
    expect(Object.keys(response.json<object>()).sort()).toEqual([
      'code',
      'i18nKey',
      'requestId',
      'status',
      'title',
      'type',
    ]);
    await app.close();
  });
});

describe('an AppError can carry field errors', () => {
  it('sends them as paths and translation keys, and nothing else', async () => {
    const app = server();

    const response = await app.inject({ method: 'GET', url: '/rejected-fields' });
    const body = Problem.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({ code: 'validation_failed' });
    expect(body.errors).toEqual([
      { path: 'password', i18nKey: 'auth.password.common' },
      { path: 'password', i18nKey: 'auth.password.too_short' },
    ]);
    await app.close();
  });
});
