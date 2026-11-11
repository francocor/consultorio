import { describe, expect, it } from 'vitest';

import { sealUploadPayload, signUploadToken, verifyUploadToken } from './upload-token.js';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';
const OTHER_TENANT = '0190a000-0000-7000-8000-0000000000b2';
const SECRET = 'placeholder-upload-secret-0123456789-abcdef';
const NOW = new Date('2026-10-20T12:00:00Z');

const grant = {
  tenantId: TENANT,
  key: `t/${TENANT}/quarantine/0190a000-0000-7000-8000-0000000000c3`,
  contentType: 'application/pdf',
  maxBytes: 20 * 1024 * 1024,
  expiresAt: new Date(NOW.getTime() + 15 * 60_000),
};

describe('the upload token', () => {
  it('carries exactly the grant it was signed for', () => {
    const token = signUploadToken(SECRET, grant);

    expect(verifyUploadToken(SECRET, token, NOW)).toEqual(grant);
  });

  it('is made of URL-safe characters, so it can sit in a path', () => {
    expect(signUploadToken(SECRET, grant)).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('is refused when it was signed with another secret', () => {
    const token = signUploadToken(SECRET, grant);

    expect(verifyUploadToken(`${SECRET}-other`, token, NOW)).toBeNull();
  });

  it('is refused when any byte of the policy was changed', () => {
    const token = signUploadToken(SECRET, grant);
    const [payload = '', signature = ''] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forge = (changes: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ ...decoded, ...changes })).toString('base64url')}.${signature}`;

    expect(verifyUploadToken(SECRET, forge({ m: 2 * 1024 * 1024 * 1024 }), NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, forge({ c: 'text/html' }), NOW)).toBeNull();
    expect(
      verifyUploadToken(SECRET, forge({ k: `t/${TENANT}/docs/another-object` }), NOW),
    ).toBeNull();
    expect(
      verifyUploadToken(SECRET, forge({ e: Number(decoded['e']) + 86_400_000 }), NOW),
    ).toBeNull();
    expect(verifyUploadToken(SECRET, forge({}), NOW)).toEqual(grant);
  });

  it('is refused when the signature was changed or removed', () => {
    const token = signUploadToken(SECRET, grant);

    expect(verifyUploadToken(SECRET, `${token.slice(0, -2)}AA`, NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, token.split('.')[0] ?? '', NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, `${token}.extra`, NOW)).toBeNull();
  });

  it('is refused once it expired, and not before', () => {
    const token = signUploadToken(SECRET, grant);

    expect(verifyUploadToken(SECRET, token, new Date(grant.expiresAt.getTime() - 1))).toEqual(
      grant,
    );
    expect(verifyUploadToken(SECRET, token, grant.expiresAt)).toBeNull();
    expect(verifyUploadToken(SECRET, token, new Date(grant.expiresAt.getTime() + 1))).toBeNull();
  });

  it.each(['', 'x', '.', 'a.b', '....', 'not a token', 'e30.e30', 'x'.repeat(5000)])(
    'is refused for garbage: %s',
    (garbage) => {
      expect(verifyUploadToken(SECRET, garbage, NOW)).toBeNull();
    },
  );

  it('never signs a key that is outside the prefix of its tenant', () => {
    expect(() => signUploadToken(SECRET, { ...grant, tenantId: OTHER_TENANT })).toThrow();
    expect(() =>
      signUploadToken(SECRET, { ...grant, key: `t/${TENANT}/docs/../../t/${OTHER_TENANT}/a` }),
    ).toThrow();
  });

  it('is refused when a signed token names a key outside the prefix of its tenant', () => {
    // Signed by the holder of the secret, but for a key that no adapter would accept.
    const sealed = (key: string, tenantId = TENANT) =>
      sealUploadPayload(SECRET, {
        t: tenantId,
        k: key,
        c: 'application/pdf',
        m: 1024,
        e: NOW.getTime() + 60_000,
      });

    expect(verifyUploadToken(SECRET, sealed(`t/${TENANT}/docs/a`), NOW)).not.toBeNull();
    expect(verifyUploadToken(SECRET, sealed('docs/a.pdf'), NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, sealed(`t/${TENANT}/docs/../../x`), NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, sealed(`t/${OTHER_TENANT}/docs/a`), NOW)).toBeNull();
  });
});
