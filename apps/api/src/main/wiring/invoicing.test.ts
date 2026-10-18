import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/fake-email/index.js';
import { createVideoJoinRegistry } from '../../modules/notifications/index.js';
import { loadConfig } from '../config.js';

import { invoicingWiring } from './invoicing.js';

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

function contribution() {
  const worker = invoicingWiring.worker;
  if (!worker) throw new Error('invoicing adds nothing to the worker');
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
  log: {} as never,
};

describe('what invoicing adds to the worker', () => {
  it('registers the credential watch on its queue, as a job that a read-only tenant does not run', () => {
    const jobs = contribution().jobs?.(workerContext);

    expect(jobs?.map((job) => job.name)).toEqual(['fiscal.credential_watch']);
    expect(jobs?.[0]?.category).toBe('write');
  });

  it('looks at every organization certificate every six hours', () => {
    const schedules = contribution().schedules?.(workerContext);

    expect(schedules).toHaveLength(1);
    expect(schedules?.[0]).toMatchObject({
      name: 'fiscal.credential_watch tick',
      intervalMs: 6 * 3_600_000,
    });
  });
});
