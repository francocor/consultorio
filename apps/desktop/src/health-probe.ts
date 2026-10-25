import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { get } from 'node:http';

/**
 * The proof that a process holds the secret of the run: HMAC-SHA256 of the nonce, in hex. The API computes
 * the same value (`healthProof` in `apps/api/src/platform/http/desktop-guard.ts`); change both together.
 */
export function healthProof(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(`consulvia-health:${nonce}`).digest('hex');
}

function sameProof(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when what listens on `port` is the API this run started: it answers `/health` with 200 AND with the
 * proof for a fresh nonce, which only a process that was given the secret can make. Any program of the PC
 * can listen on a loopback port, so a bare 200 proves nothing. The secret itself never leaves the shell.
 */
export function probeApiHealth(port: number, secret: string, timeoutMs = 2_000): Promise<boolean> {
  const nonce = randomBytes(24).toString('base64url');
  return new Promise((resolve) => {
    const request = get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: timeoutMs,
        headers: { 'x-consulvia-nonce': nonce },
      },
      (response) => {
        response.resume();
        const proof = response.headers['x-consulvia-proof'];
        resolve(
          response.statusCode === 200 &&
            typeof proof === 'string' &&
            sameProof(proof, healthProof(secret, nonce)),
        );
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => {
      resolve(false);
    });
  });
}
