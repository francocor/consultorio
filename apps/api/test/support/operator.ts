import { randomBytes, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createOperatorAdminFor, createOperatorSecrets } from '../../src/modules/operator/index.js';
import { codeAt, decodeBase32Secret, totpStepAt } from '../../src/platform/crypto/totp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

import { BASE_DOMAIN } from './app.js';

export const PLATFORM_HOST = `platform.${BASE_DOMAIN}`;
export const OPERATOR_PASSWORD = 'una frase larga para operar la plataforma';

/** Headers a browser on the platform host sends. */
export const platformHeaders = (cookie?: string) => ({
  host: PLATFORM_HOST,
  origin: `https://${PLATFORM_HOST}`,
  'user-agent': 'vitest-operator-browser',
  ...(cookie === undefined ? {} : { cookie }),
});

export interface TestOperator {
  id: string;
  email: string;
  password: string;
  secret: Uint8Array;
}

/** A clock the tests move by hand: a code works once, so each sign-in needs a later step. */
export interface TestClock {
  now: Date;
  read: () => Date;
  advance: (ms: number) => void;
}

export function createTestClock(start = new Date()): TestClock {
  const clock: TestClock = {
    now: start,
    read: () => clock.now,
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

export interface OperatorHarness {
  /** The connection of the `app_operator` role. */
  db: DbHandle;
  secrets: ReturnType<typeof createOperatorSecrets>;
  addOperator(options?: { email?: string; password?: string }): Promise<TestOperator>;
  close(): Promise<void>;
}

let counter = 0;

/** The operator side of a test: its own connection as `app_operator` and a way to create operators. */
export function createOperatorHarness(): OperatorHarness {
  const db = createRuntimeDb(inject('operatorUrl'));
  const secrets = createOperatorSecrets(
    createLocalKeyManagement(randomBytes(32).toString('base64')),
  );
  const admin = createOperatorAdminFor({ db: db.db, hasher: createPasswordHasher(), secrets });

  return {
    db,
    secrets,
    async addOperator(options = {}) {
      counter += 1;
      // Test files share one database, so an address must be unique across files.
      const email = options.email ?? `operator-${randomUUID().slice(0, 8)}@platform.test`;
      const password = options.password ?? OPERATOR_PASSWORD;
      const created = await admin.create({
        email,
        displayName: `Operator ${String(counter)}`,
        password,
      });
      return {
        id: created.id,
        email,
        password,
        secret: decodeBase32Secret(created.totpSecretBase32),
      };
    },
    close: () => db.close(),
  };
}

/** The code the authenticator app would show at `at`, shifted by whole steps if asked. */
export function codeFor(operator: TestOperator, at: Date, stepOffset = 0): string {
  return codeAt(operator.secret, totpStepAt(at) + stepOffset);
}

/** Signs an operator in on the platform host; returns the response and the `osid=...` pair. */
export async function loginOperator(
  app: FastifyInstance,
  operator: TestOperator,
  clock: TestClock,
  overrides: { password?: string; code?: string } = {},
) {
  // Each sign-in uses a fresh time step, so the replay rule never trips over an earlier one.
  clock.advance(31_000);
  const response = await app.inject({
    method: 'POST',
    url: '/operator/auth/login',
    headers: platformHeaders(),
    remoteAddress: '10.97.0.1',
    payload: {
      email: operator.email,
      password: overrides.password ?? operator.password,
      code: overrides.code ?? codeFor(operator, clock.now),
    },
  });
  const pair = (
    Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]
      : response.headers['set-cookie']
  )?.split(';')[0];
  return { response, cookie: pair?.startsWith('osid=') && pair !== 'osid=' ? pair : undefined };
}

/** Signs in and returns the cookie, failing the test if the sign-in did not work. */
export async function operatorSession(
  app: FastifyInstance,
  operator: TestOperator,
  clock: TestClock,
): Promise<string> {
  const { response, cookie } = await loginOperator(app, operator, clock);
  if (response.statusCode !== 200 || cookie === undefined) {
    throw new Error(`operator sign-in failed with status ${String(response.statusCode)}`);
  }
  return cookie;
}
