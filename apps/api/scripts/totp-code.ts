import { codeAt, decodeBase32Secret, totpStepAt } from '../src/platform/crypto/totp.js';

/**
 * Prints the six-digit code an authenticator app would show right now for a base32 secret, so a
 * developer can sign in as a platform operator without a phone:
 *
 *   TOTP_SECRET='JBSWY3DPEHPK3PXP' pnpm --filter @consultorio/api operator:code
 *
 * The secret comes from the environment so it never lands in a shell history. Development only:
 * on a real deployment the secret belongs in the operator's own authenticator app.
 */
const secret = process.env['TOTP_SECRET'];
if (!secret) {
  process.stderr.write('Usage: TOTP_SECRET=<base32 secret> operator:code\n');
  process.exit(2);
}
if (process.env['NODE_ENV'] === 'production') {
  process.stderr.write('This helper never runs in production.\n');
  process.exit(2);
}
const now = new Date();
const secondsLeft = 30 - Math.floor((now.getTime() / 1000) % 30);
process.stdout.write(
  `${codeAt(decodeBase32Secret(secret), totpStepAt(now))}  (valid for about ${String(secondsLeft)} s)\n`,
);
