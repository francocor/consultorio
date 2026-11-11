import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/fake-email/index.js';
import { createVideoJoinRegistry, bindOfferDelivery } from '../../modules/notifications/index.js';
import { createTenantLifecycle } from '../../modules/tenancy/index.js';
import {
  WAITLIST_EXPIRE_JOB,
  WAITLIST_MATCH_JOB,
  WAITLIST_OFFER_JOB,
} from '../../modules/waitlist/index.js';
import type { Tx } from '../../platform/db/tenant-context.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import { loadConfig } from '../config.js';

import { deliverThroughNotifications, waitlistWiring } from './waitlist.js';

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

function contribution() {
  const worker = waitlistWiring.worker;
  if (!worker) throw new Error('the waitlist adds nothing to the worker');
  return worker({
    config: loadConfig(env),
    adapters: { forTenant: () => undefined },
    email: createFakeEmailSender(),
    videoJoin: createVideoJoinRegistry(),
    tenantLifecycle: createTenantLifecycle(),
  });
}

describe('what the waitlist adds to the worker', () => {
  it('registers the three jobs of the waitlist, each on its own queue', () => {
    const jobs = contribution().jobs?.({
      client: { enqueue: () => Promise.resolve(null) } satisfies JobClient,
      db: {} as never,
      metrics: {} as never,
      log: {} as never,
    });

    expect(jobs?.map((job) => job.name).sort()).toEqual(
      [WAITLIST_EXPIRE_JOB, WAITLIST_MATCH_JOB, WAITLIST_OFFER_JOB].sort(),
    );
    // Every job re-checks the organization: none runs while it is read-only.
    for (const job of jobs ?? []) expect(job.category).toBe('write');
  });

  it('sweeps every organization once a minute', () => {
    const schedules = contribution().schedules?.({
      client: {} as never,
      db: {} as never,
      metrics: {} as never,
      log: {} as never,
    });

    expect(schedules).toHaveLength(1);
    expect(schedules?.[0]).toMatchObject({ name: 'waitlist.expire tick', intervalMs: 60_000 });
  });
});

describe('what the waitlist needs from the application', () => {
  it('needs the job queue, since a cancellation enqueues the match in its own transaction', () => {
    expect(waitlistWiring.needsJobs).toBe(true);
  });

  it('owns the settings section of the waitlist and no adapter slot', () => {
    expect(waitlistWiring.settingsSections?.map((section) => section.key)).toEqual(['waitlist']);
    expect(waitlistWiring.adapters).toBeUndefined();
  });
});

describe('delivering an offer through notifications', () => {
  const input = {
    offerId: '0190a000-0000-7000-8000-000000000001',
    patientId: '0190a000-0000-7000-8000-000000000002',
    professionalId: '0190a000-0000-7000-8000-000000000003',
    locationId: '0190a000-0000-7000-8000-000000000004',
    startsAt: new Date('2031-05-12T13:00:00.000Z'),
    endsAt: new Date('2031-05-12T13:30:00.000Z'),
    expiresAt: new Date('2031-05-05T12:30:00.000Z'),
    offerTokenUrl: 'https://aillu.test/public/t/TOKEN',
  };

  it('fails loudly in a process that never built the notifications module, instead of leaving every patient "unreachable"', async () => {
    bindOfferDelivery(undefined);

    await expect(deliverThroughNotifications({} as Tx, input)).rejects.toThrow(
      'notifications module',
    );
  });
});
