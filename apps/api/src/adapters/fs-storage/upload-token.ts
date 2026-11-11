import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertTenantKey } from '../../platform/storage/object-storage.js';
import type { UploadGrant } from '../../platform/storage/upload-receiver.js';

/**
 * The link of an upload to the filesystem storage: `<payload>.<signature>`, both base64url. The payload
 * is the policy S3 would state in a presigned POST (the object, its content type, a size cap and an
 * expiry), and the signature is an HMAC-SHA256 under the secret of the install, so the browser can
 * carry the policy but not change it. The version prefix keeps the HMAC of one use from being valid
 * for another.
 */
const VERSION = 'consulvia/fs-upload/v1';
/** A token is a few hundred characters; anything longer is not one, and is not worth decoding. */
const MAX_TOKEN_LENGTH = 2048;

const signatureOf = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest();

/** Signs any payload. `signUploadToken` is the way to make a real one; tests forge with this. */
export function sealUploadPayload(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signatureOf(secret, body).toString('base64url')}`;
}

export function signUploadToken(secret: string, grant: UploadGrant): string {
  // Never sign a key that no adapter would accept.
  assertTenantKey(grant.tenantId, grant.key);
  return sealUploadPayload(secret, {
    t: grant.tenantId,
    k: grant.key,
    c: grant.contentType,
    m: grant.maxBytes,
    e: grant.expiresAt.getTime(),
  });
}

/** The grant a token carries, or null for anything that is not a live token of this install. */
export function verifyUploadToken(secret: string, token: string, now: Date): UploadGrant | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) return null;

  const given = Buffer.from(signature, 'base64url');
  const expected = signatureOf(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { t, k, c, m, e } = payload as Record<string, unknown>;
  if (
    typeof t !== 'string' ||
    typeof k !== 'string' ||
    typeof c !== 'string' ||
    typeof m !== 'number' ||
    !Number.isSafeInteger(m) ||
    m < 1 ||
    typeof e !== 'number' ||
    !Number.isSafeInteger(e)
  ) {
    return null;
  }
  if (now.getTime() >= e) return null;
  try {
    assertTenantKey(t, k);
  } catch {
    return null;
  }
  return { tenantId: t, key: k, contentType: c, maxBytes: m, expiresAt: new Date(e) };
}
