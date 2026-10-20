import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/fake-email/index.js';
import { createVideoJoinRegistry } from '../../modules/notifications/index.js';
import { loadConfig } from '../config.js';

import { signupWiring } from './signup.js';

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

function contribution() {
  const worker = signupWiring.worker;
  if (!worker) throw new Error('the signup adds nothing to the worker');
  return worker({
    config: loadConfig(env),
    adapters: { forTenant: () => undefined },
    email: createFakeEmailSender(),
    videoJoin: createVideoJoinRegistry(),
  });
}

const workerContext = {
  client: {} as never,
  db: {} as never,
  metrics: {} as never,
  log: { info: () => undefined, error: () => undefined },
};

describe('what the signup adds to the worker', () => {
  it('purges the signups nobody confirmed and retries the verification emails, as passes of its own', () => {
    const schedules = contribution().schedules?.(workerContext);

    expect(schedules?.map((schedule) => schedule.name).sort()).toEqual([
      'signup verification retry',
      'signup.purge pass',
    ]);
    expect(
      schedules?.find((schedule) => schedule.name === 'signup verification retry'),
    ).toMatchObject({ intervalMs: 60_000 });
    expect(schedules?.find((schedule) => schedule.name === 'signup.purge pass')).toMatchObject({
      intervalMs: 6 * 3_600_000,
    });
  });

  it('adds no job of an organization: a write job is cancelled for the very organization the purge removes', () => {
    const added = contribution();

    expect(added.jobs).toBeUndefined();
    expect(added.tenantJobs).toBeUndefined();
  });
});

describe('what the signup adds to the API', () => {
  it('needs no queue in the API: the retry of the email is a pass of the worker', () => {
    expect(signupWiring.name).toBe('signup');
    expect(signupWiring.needsJobs).toBeUndefined();
  });
});
