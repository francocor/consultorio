import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedPlatformDemo } from '../../src/db/seed/demo/stage6/platform-tenants.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { collectPlatformMetrics } from '../../src/main/platform-metrics.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import { METRIC_DESCRIPTIONS } from '../../src/platform/metrics-catalog.js';
import { createMetrics, type Metrics } from '../../src/platform/metrics.js';
import { BASE_DOMAIN } from '../support/app.js';
import { TENANT_FIXTURES } from '../support/fixtures.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The numbers the alert rules read (task 6.45): queue depth, the failure rate of the messages, the
 * invoices that stayed pending past the outage threshold, the documents waiting for the scan, the
 * audit events not sealed yet, and the subscriptions by state and reminder of the dunning. The worker
 * measures them across the organizations (each in its own transaction, so isolation holds); the oracle
 * of every figure here is ONE query as the superuser, which sees them all.
 */

let runtime: DbHandle;
let admin: pg.Client;
let metrics: Metrics;
let measuredAt: number;

const ONE = async <T>(statement: string, ...params: unknown[]): Promise<T> => {
  const result = await admin.query(statement, params);
  return result.rows[0] as T;
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  const ownerDb = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(ownerDb.db);
  await ownerDb.close();

  // Subscriptions in the four states, with the reminders of the dunning.
  await seedPlatformDemo({
    db: runtime.db,
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    origins: createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true }),
    webhookSecret: randomBytes(24).toString('hex'),
    publicBaseUrl: `https://platform.${BASE_DOMAIN}`,
    environment: 'test',
  });

  // An organization with a failed reminder, a document waiting for its scan and an invoice that has
  // been pending for three days (the default threshold is 24 hours).
  const tenant = await createTestTenant(runtime, { slug: 'metrics-org' });
  for (const table of ['message', 'document', 'invoice']) {
    const fixture = TENANT_FIXTURES[table];
    if (!fixture) throw new Error(`no fixture for ${table}`);
    await asTenant(runtime, tenant.id, (tx) => fixture.insert(tx, tenant.id));
  }
  await admin.query('SET session_replication_role = replica');
  await admin.query(
    `update message set status = 'failed', failure_reason = 'delivery_failed' where tenant_id = $1`,
    [tenant.id],
  );
  await admin.query(
    `update invoice set created_at = now() - interval '3 days' where tenant_id = $1`,
    [tenant.id],
  );
  await admin.query(
    `update document set upload_completed_at = now() - interval '2 hours' where tenant_id = $1`,
    [tenant.id],
  );
  await admin.query('SET session_replication_role = DEFAULT');

  metrics = createMetrics({ catalog: METRIC_DESCRIPTIONS });
  measuredAt = Date.now();
  await collectPlatformMetrics({ db: runtime.db, metrics });
}, 300_000);

afterAll(async () => {
  await admin.end();
  await runtime.close();
});

describe('what the worker measures across the organizations', () => {
  it('counts the messages of the last day by status, as the one query that sees them all does', async () => {
    const expected = await admin.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from message
        where created_at > now() - interval '24 hours' group by status`,
    );

    expect(expected.rows.find((row) => row.status === 'failed')?.n).toBeGreaterThanOrEqual(1);
    for (const status of ['queued', 'sent', 'delivered', 'read', 'failed', 'cancelled']) {
      const want = expected.rows.find((row) => row.status === status)?.n ?? 0;
      expect(metrics.get('messages_last_day', { status }), status).toBe(want);
    }
  });

  it('counts the invoices pending past the threshold, the documents waiting for the scan and how long the oldest waited', async () => {
    const invoices = await ONE<{ n: number }>(
      `select count(*)::int as n from invoice i
        where i.status = 'pending'
          and i.created_at < now() - make_interval(hours => coalesce(
                (select (t.settings -> 'invoicing' ->> 'outageThresholdHours')::int
                   from tenant t where t.id = i.tenant_id), 24))`,
    );
    const documents = await ONE<{ n: number; oldest: number }>(
      `select count(*)::int as n,
              coalesce(extract(epoch from now() - min(upload_completed_at)), 0)::float as oldest
         from document
        where status = 'quarantined' and upload_completed_at is not null and abandoned_at is null`,
    );

    expect(invoices.n).toBeGreaterThanOrEqual(1);
    expect(metrics.get('invoices_pending_past_threshold')).toBe(invoices.n);
    expect(documents.n).toBeGreaterThanOrEqual(1);
    expect(metrics.get('documents_scan_backlog')).toBe(documents.n);
    // The oldest wait is at least the two hours the fixture gave it, and no more than the oracle now.
    expect(metrics.get('documents_scan_oldest_waiting_seconds')).toBeGreaterThanOrEqual(7200);
    expect(metrics.get('documents_scan_oldest_waiting_seconds')).toBeLessThanOrEqual(
      documents.oldest + 5,
    );
  });

  it('counts the audit events that are not sealed yet', async () => {
    const unsealed = await ONE<{ n: number }>(
      'select count(*)::int as n from audit_event where seq is null',
    );

    expect(unsealed.n).toBeGreaterThan(10);
    expect(metrics.get('audit_unsealed_events')).toBe(unsealed.n);
    expect(metrics.get('audit_oldest_unsealed_seconds')).toBeGreaterThan(0);
  });

  it('counts the subscriptions by state and the past due ones by the reminder of the dunning', async () => {
    const states = await admin.query<{ status: string; n: number }>(
      'select status, count(*)::int as n from subscription group by status',
    );
    const steps = await admin.query<{ step: number; n: number }>(
      `select dunning_step as step, count(*)::int as n from subscription
        where status = 'past_due' group by dunning_step`,
    );

    expect(states.rows.map((row) => row.status)).toEqual(
      expect.arrayContaining(['trial', 'active', 'past_due', 'read_only']),
    );
    for (const status of ['trial', 'active', 'past_due', 'read_only', 'cancelling', 'cancelled']) {
      const want = states.rows.find((row) => row.status === status)?.n ?? 0;
      expect(metrics.get('subscriptions', { status }), status).toBe(want);
    }
    expect(steps.rows.find((row) => row.step === 2)?.n).toBeGreaterThanOrEqual(1);
    for (const step of [0, 1, 2, 3]) {
      const want = steps.rows.find((row) => row.step === step)?.n ?? 0;
      expect(metrics.get('subscription_dunning_step', { step: String(step) }), String(step)).toBe(
        want,
      );
    }
  });

  it('counts the organizations by status, the unconfirmed signups included', async () => {
    const tenants = await admin.query<{ status: string; n: number }>(
      'select status, count(*)::int as n from tenant group by status',
    );

    for (const status of ['active', 'read_only', 'cancelled', 'unverified']) {
      const want = tenants.rows.find((row) => row.status === status)?.n ?? 0;
      expect(metrics.get('tenants', { status }), status).toBe(want);
    }
    expect(metrics.get('tenants', { status: 'read_only' })).toBeGreaterThanOrEqual(1);
  });

  it('counts the jobs of the queues by state, and forgets a queue that emptied', async () => {
    const jobs = await admin.query<{ name: string; state: string; n: number }>(
      `select name, state::text as state, count(*)::int as n from pgboss.job
        where state in ('created', 'retry', 'active') group by name, state`,
    );
    for (const row of jobs.rows) {
      expect(metrics.get('queue_jobs', { queue: row.name, state: row.state }), row.name).toBe(
        row.n,
      );
    }

    await admin.query(
      `insert into pgboss.job (name, data, state) values ('test.backlog', '{}', 'created')`,
    );
    await collectPlatformMetrics({ db: runtime.db, metrics });
    expect(
      metrics.get('queue_jobs', { queue: 'test.backlog', state: 'created' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      metrics.get('queue_oldest_waiting_seconds', { queue: 'test.backlog' }),
    ).toBeGreaterThanOrEqual(0);

    await admin.query(`delete from pgboss.job where name = 'test.backlog'`);
    await collectPlatformMetrics({ db: runtime.db, metrics });
    expect(metrics.get('queue_jobs', { queue: 'test.backlog', state: 'created' })).toBe(0);
    expect(metrics.render()).not.toContain('queue="test.backlog"');
  });

  it('says when it measured, so an alert can tell a quiet platform from a worker that stopped', () => {
    const at = metrics.get('platform_metrics_collected_at_seconds');

    expect(at * 1000).toBeGreaterThanOrEqual(measuredAt - 1000);
    expect(at * 1000).toBeLessThanOrEqual(Date.now() + 1000);
    expect(metrics.get('platform_metrics_collection_errors_total')).toBe(0);
  });

  it('exposes only counts and short codes: no name, no address, no text of a patient', () => {
    const text = metrics.render();

    expect(text).toContain('# TYPE subscriptions gauge');
    expect(text).not.toMatch(/@|Gomez|Rios|propietaria|Paciente/i);
  });
});
