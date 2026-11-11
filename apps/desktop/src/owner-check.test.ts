import { describe, expect, it } from 'vitest';

import {
  verifyOwner,
  type OwnerAnswer,
  type OwnerCall,
  type OwnerCheckOptions,
  type OwnerTransport,
} from './owner-check.js';

const OPTIONS: OwnerCheckOptions = {
  apiPort: 9,
  proxySecret: 'secret',
  publicOrigin: 'http://127.0.0.1:47800',
  email: 'ana@clinica.example',
  password: 'a long private sentence',
};

/** An API that answers by path; every call is kept. */
function api(answers: Record<string, OwnerAnswer | Error>) {
  const calls: OwnerCall[] = [];
  const transport: OwnerTransport = (call) => {
    calls.push(call);
    const answer = answers[`${call.method} ${call.path}`] ?? {
      status: 404,
      body: null,
      cookies: [],
    };
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { calls, transport };
}

const ok = (body: unknown, cookies: string[] = []): OwnerAnswer => ({ status: 200, body, cookies });
const ME_OWNER = ok({ roles: ['owner', 'admin'] });

describe('proving that whoever asks is an owner, through the API itself', () => {
  it('accepts the password of an owner without a second factor, asks nothing else, and ends the session', async () => {
    const { calls, transport } = api({
      'POST /auth/login': ok({ next: 'authenticated' }, ['sid=abc']),
      'GET /auth/me': ME_OWNER,
      'POST /auth/logout': ok(null),
    });

    expect(await verifyOwner(OPTIONS, transport)).toEqual({ ok: true });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /auth/login',
      'GET /auth/me',
      'POST /auth/logout',
    ]);
    expect(calls[0]?.body).toEqual({ email: OPTIONS.email, password: OPTIONS.password });
    expect(calls[1]?.cookie).toBe('sid=abc');
    expect(calls[2]?.cookie).toBe('sid=abc');
  });

  it('asks for the code when the account has a second factor, and checks it with the API', async () => {
    const { calls, transport } = api({
      'POST /auth/login': ok({ next: 'totp', challenge: 'c-1' }),
      'POST /auth/2fa': ok({ next: 'authenticated' }, ['sid=second']),
      'GET /auth/me': ME_OWNER,
      'POST /auth/logout': ok(null),
    });

    expect(await verifyOwner(OPTIONS, transport)).toEqual({ ok: false, reason: 'needs_code' });
    expect(calls.map((call) => call.path)).toEqual(['/auth/login']);

    const second = api({
      'POST /auth/login': ok({ next: 'totp', challenge: 'c-1' }),
      'POST /auth/2fa': ok({ next: 'authenticated' }, ['sid=second']),
      'GET /auth/me': ME_OWNER,
      'POST /auth/logout': ok(null),
    });
    expect(await verifyOwner({ ...OPTIONS, code: ' 123456 ' }, second.transport)).toEqual({
      ok: true,
    });
    expect(second.calls[1]?.body).toEqual({ challenge: 'c-1', code: '123456' });
    expect(second.calls[2]?.cookie).toBe('sid=second');
  });

  it('refuses a wrong password, a wrong code, and says nothing about which', async () => {
    const wrongPassword = api({ 'POST /auth/login': { status: 401, body: null, cookies: [] } });
    const wrongCode = api({
      'POST /auth/login': ok({ next: 'totp', challenge: 'c-1' }),
      'POST /auth/2fa': { status: 401, body: null, cookies: [] },
    });

    expect(await verifyOwner(OPTIONS, wrongPassword.transport)).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(await verifyOwner({ ...OPTIONS, code: '000000' }, wrongCode.transport)).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('refuses an account that is not an owner, even with the right password, and ends its session', async () => {
    const { calls, transport } = api({
      'POST /auth/login': ok({ next: 'authenticated' }, ['sid=abc']),
      'GET /auth/me': ok({ roles: ['reception'] }),
      'POST /auth/logout': ok(null),
    });

    expect(await verifyOwner(OPTIONS, transport)).toEqual({ ok: false, reason: 'refused' });

    expect(calls.at(-1)?.path).toBe('/auth/logout');
  });

  it('refuses an answer it does not understand, and an API that is not there', async () => {
    expect(
      await verifyOwner(
        OPTIONS,
        api({ 'POST /auth/login': ok({ next: 'something-new' }) }).transport,
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await verifyOwner(OPTIONS, api({ 'POST /auth/login': new Error('ECONNREFUSED') }).transport),
    ).toEqual({ ok: false, reason: 'unavailable' });
    // A sign-in that sets no session is not a proof.
    expect(
      await verifyOwner(
        OPTIONS,
        api({ 'POST /auth/login': ok({ next: 'authenticated' }) }).transport,
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('accepts a password that leads to the enrollment of the second factor: the password was right', async () => {
    const { transport } = api({
      'POST /auth/login': ok({ next: 'enrollment' }, ['sid=abc']),
      'GET /auth/me': ME_OWNER,
      'POST /auth/logout': ok(null),
    });

    expect(await verifyOwner(OPTIONS, transport)).toEqual({ ok: true });
  });
});
