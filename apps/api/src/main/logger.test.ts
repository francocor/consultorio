import { describe, expect, it } from 'vitest';

import { captureLogs } from '../testing/log-capture.js';

import { serializeRequest, stripQuery } from './logger.js';
import { buildServer } from './server.js';

describe('stripQuery', () => {
  it.each([
    ['/auth/reset?token=abc', '/auth/reset'],
    ['/patients?q=perez&page=2', '/patients'],
    ['/page#section', '/page'],
    ['/plain', '/plain'],
    ['/?x=1', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(stripQuery(input)).toBe(expected);
  });
});

describe('serializeRequest', () => {
  it('drops the query string', () => {
    expect(
      serializeRequest({ method: 'GET', url: '/a?token=t', host: 'h', ip: '1.2.3.4' }),
    ).toEqual({
      method: 'GET',
      url: '/a',
      host: 'h',
      remoteAddress: '1.2.3.4',
    });
  });
});

describe('request logging', () => {
  it('writes the path of a real request but never its query string', async () => {
    const logs = captureLogs();
    const app = buildServer({
      logLevel: 'info',
      logStream: logs.stream,
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    });

    await app.inject({ method: 'GET', url: '/health?token=action-token-123&q=maria' });
    await app.inject({ method: 'GET', url: '/missing?token=action-token-123' });
    await app.close();

    const output = logs.raw();
    expect(output).toContain('"url":"/health"');
    expect(output).toContain('"url":"/missing"');
    expect(output).not.toContain('action-token-123');
    expect(output).not.toContain('maria');
  });

  it('redacts credentials, cookies and bodies', async () => {
    const logs = captureLogs();
    const app = buildServer({
      logLevel: 'info',
      logStream: logs.stream,
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    });
    await app.ready();

    app.log.info({
      req: { headers: { authorization: 'Bearer very-secret-token', cookie: 'sid=very-secret' } },
      body: { diagnosis: 'very-secret-diagnosis' },
    });
    await app.close();

    const output = logs.raw();
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('very-secret');
  });
});
