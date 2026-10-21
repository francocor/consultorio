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

/** The organizations the worker reads in full: not a cancelled one (JD-S6 R1-S6-5), not an unconfirmed signup. */
const LIVE = `select id from tenant where status not in ('cancelled', 'unverified')`;

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
        where created_at > now() - interval '24 hours' and tenant_id in (${LIVE}) group by status`,
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
        where i.status = 'pending' and i.tenant_id in (${LIVE})
          and i.created_at < now() - make_interval(hours => coalesce(
                (select case when t.settings -> 'invoicing' ->> 'outageThresholdHours' ~ '^[0-9]{1,4}$'
                             then (t.settings -> 'invoicing' ->> 'outageThresholdHours')::int end
                   from tenant t where t.id = i.tenant_id), 24))`,
    );
    const documents = await ONE<{ n: number; oldest: number }>(
      `select count(*)::int as n,
              coalesce(extract(epoch from now() - min(upload_completed_at)), 0)::float as oldest
         from document
        where status = 'quarantined' and upload_completed_at is not null and abandoned_at is null
          and tenant_id in (${LIVE})`,
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
    // The database is shared with the other test files, which write and seal audit events while this
    // one runs, so one figure taken earlier cannot be compared with a later query. The comparison is
    // made at a quiet moment: the oracle before and after a fresh measurement must agree, and then the
    // measurement has to agree with both. A figure that counted something else never would.
    const oracle = async () =>
      (
        await ONE<{ n: number }>(
          `select count(*)::int as n from audit_event where seq is null and tenant_id in (${LIVE})`,
        )
      ).n;
    let agreed: { unsealed: number; measured: number } | null = null;
    let last = 'no attempt';
    for (let attempt = 0; attempt < 40 && agreed === null; attempt += 1) {
      const fresh = createMetrics({ catalog: METRIC_DESCRIPTIONS });
      const before = await oracle();
      await collectPlatformMetrics({ db: runtime.db, metrics: fresh });
      const after = await oracle();
      const measured = fresh.get('audit_unsealed_events');
      last = `before ${String(before)}, measured ${String(measured)}, after ${String(after)}`;
      if (before === after) agreed = { unsealed: before, measured };
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(agreed, `no quiet moment to compare at (${last})`).not.toBeNull();
    expect(agreed?.unsealed).toBeGreaterThan(10);
    expect(agreed?.measured).toBe(agreed?.unsealed);
    expect(metrics.get('audit_oldest_unsealed_seconds')).toBeGreaterThan(0);
  });

  it('counts the subscriptions by state and the past due ones by the reminder of the dunning', async () => {
    const states = await admin.query<{ status: string; n: number }>(
      'select status, count(*)::int as n from subscription group by status',
    );
    const steps = await admin.query<{ step: number; n: number }>(
      `select dunning_step as step, count(*)::int as n from subscription
        where status = 'past_due' and tenant_id in (${LIVE}) group by dunning_step`,
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

describe('what the alert rules of Stage 6 read (JD-S6 R1-S6-5)', () => {
  const fresh = async () => {
    const next = createMetrics({ catalog: METRIC_DESCRIPTIONS });
    await collectPlatformMetrics({ db: runtime.db, metrics: next });
    return next;
  };

  it('counts the subscriptions parked for a person by reason, the stalest reconciliation and the surplus nobody reviewed', async () => {
    const parked = await createTestTenant(runtime, { slug: 'metrics-parked' });
    await admin.query(
      `insert into subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages,
                                 provider_preapproval_id, external_reference, last_reconciled_at,
                                 attention_reason, attention_at)
       select $1, id, 'trial', now() + interval '14 days', 300, 'PRE-METRICS-1', 'sub:metrics-1',
              now() - interval '3 hours', 'ambiguous_preapproval', now()
         from plan where key = 'standard'`,
      [parked.id],
    );
    await admin.query(
      `insert into subscription_payment (tenant_id, subscription_id, provider_payment_id, purpose, reference,
                                         amount_cents, status, surplus, credited, provider_created_at)
       select $1, s.id, 'PAY-METRICS-1', 'charge', 'sub:metrics-1', 3600000, 'approved', true, true, now()
         from subscription s where s.tenant_id = $1`,
      [parked.id],
    );

    const measured = await fresh();

    const reasons = await admin.query<{ reason: string; n: number }>(
      `select attention_reason as reason, count(*)::int as n from subscription
        where attention_reason is not null and tenant_id in (${LIVE}) group by 1`,
    );
    const unreviewed = await ONE<{ n: number }>(
      `select count(*)::int as n from subscription_payment
        where surplus and surplus_reviewed_at is null and tenant_id in (${LIVE})`,
    );
    for (const reason of [
      'ambiguous_preapproval',
      'identity_mismatch',
      'unexpected_state',
      'reauthorization_needed',
    ]) {
      const want = reasons.rows.find((row) => row.reason === reason)?.n ?? 0;
      expect(measured.get('subscriptions_parked', { reason }), reason).toBe(want);
    }
    expect(
      measured.get('subscriptions_parked', { reason: 'ambiguous_preapproval' }),
    ).toBeGreaterThanOrEqual(1);
    expect(measured.get('subscription_reconcile_oldest_seconds')).toBeGreaterThanOrEqual(3 * 3600);
    expect(measured.get('subscription_surplus_unreviewed')).toBe(unreviewed.n);
    expect(unreviewed.n).toBeGreaterThanOrEqual(1);
  });

  it('is not stopped by one organization with a threshold that is not a number, which counts as the default', async () => {
    const odd = await createTestTenant(runtime, { slug: 'metrics-odd-threshold' });
    await admin.query(
      `update tenant set settings = jsonb_build_object('invoicing', jsonb_build_object('outageThresholdHours', 'tres dias')) where id = $1`,
      [odd.id],
    );

    const measured = await fresh();

    expect(measured.get('platform_metrics_collection_errors_total')).toBe(0);
    expect(measured.get('invoices_pending_past_threshold')).toBeGreaterThanOrEqual(1);
  });

  it('leaves out the organizations that were cancelled, except for their subscription', async () => {
    const gone = await createTestTenant(runtime, { slug: 'metrics-cancelled' });
    const fixture = TENANT_FIXTURES['message'];
    if (!fixture) throw new Error('no fixture for message');
    await asTenant(runtime, gone.id, (tx) => fixture.insert(tx, gone.id));
    await admin.query('SET session_replication_role = replica');
    await admin.query(
      `update message set status = 'failed', failure_reason = 'delivery_failed' where tenant_id = $1`,
      [gone.id],
    );
    await admin.query(
      `insert into subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages)
       select $1, id, 'cancelled', now() - interval '1 day', 300 from plan where key = 'standard'`,
      [gone.id],
    );
    await admin.query(`update tenant set status = 'cancelled' where id = $1`, [gone.id]);
    await admin.query('SET session_replication_role = DEFAULT');

    const measured = await fresh();

    const failedLive = await ONE<{ n: number }>(
      `select count(*)::int as n from message
        where status = 'failed' and created_at > now() - interval '24 hours' and tenant_id in (${LIVE})`,
    );
    const failedAll = await ONE<{ n: number }>(
      `select count(*)::int as n from message
        where status = 'failed' and created_at > now() - interval '24 hours'`,
    );
    const cancelledSubscriptions = await ONE<{ n: number }>(
      `select count(*)::int as n from subscription where status = 'cancelled'`,
    );
    expect(failedAll.n).toBeGreaterThan(failedLive.n);
    expect(measured.get('messages_last_day', { status: 'failed' })).toBe(failedLive.n);
    // Its subscription is still counted, so the series by state keeps adding up.
    expect(measured.get('subscriptions', { status: 'cancelled' })).toBe(cancelledSubscriptions.n);
  });

  it('keeps counting what a cancelled organization still has parked, its stale reconciliation and its unreviewed surplus (JD-S6 R2-5)', async () => {
    const gone = await createTestTenant(runtime, { slug: 'metrics-cancelled-parked' });
    await admin.query('SET session_replication_role = replica');
    await admin.query(
      `insert into subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages,
                                 provider_preapproval_id, external_reference, last_reconciled_at,
                                 attention_reason, attention_at)
       select $1, id, 'cancelled', now() - interval '30 days', 300, 'PRE-METRICS-GONE',
              'sub:metrics-gone', now() - interval '9 hours', 'unexpected_state', now()
         from plan where key = 'standard'`,
      [gone.id],
    );
    await admin.query(
      `insert into subscription_payment (tenant_id, subscription_id, provider_payment_id, purpose, reference,
                                         amount_cents, status, surplus, credited, provider_created_at)
       select $1, s.id, 'PAY-METRICS-GONE', 'charge', 'sub:metrics-gone', 3600000, 'approved', true, true, now()
         from subscription s where s.tenant_id = $1`,
      [gone.id],
    );
    await admin.query(`update tenant set status = 'cancelled' where id = $1`, [gone.id]);
    await admin.query('SET session_replication_role = DEFAULT');

    const measured = await fresh();

    const parkedAll = await ONE<{ n: number }>(
      `select count(*)::int as n from subscription where attention_reason = 'unexpected_state'`,
    );
    const unreviewedAll = await ONE<{ n: number }>(
      `select count(*)::int as n from subscription_payment where surplus and surplus_reviewed_at is null`,
    );
    expect(parkedAll.n).toBeGreaterThanOrEqual(1);
    expect(measured.get('subscriptions_parked', { reason: 'unexpected_state' })).toBe(parkedAll.n);
    expect(measured.get('subscription_surplus_unreviewed')).toBe(unreviewedAll.n);
    expect(measured.get('subscription_reconcile_oldest_seconds')).toBeGreaterThanOrEqual(9 * 3600);
  });

  it('measures the archives, the release requests, the signups and the releaser as the health function counts them', async () => {
    const written = await createTestTenant(runtime, { slug: 'metrics-archive-corrupted' });
    const failed = await createTestTenant(runtime, { slug: 'metrics-archive-failed' });
    await admin.query(
      `insert into tenant_archive (tenant_id, archive_id, key_version, status, manifest_key, manifest_sha256,
                                   objects_count, bytes_total, retain_until, archived_at, verified_at,
                                   verify_status, verify_problems)
       values ($1, app.uuid_v7(), 1, 'written', 'tenants/x/manifest.json', $2, 3, 300,
               now() + interval '3650 days', now() - interval '20 days', now() - interval '16 days',
               'corrupted', 2)`,
      [written.id, 'c'.repeat(64)],
    );
    await admin.query(
      `insert into tenant_archive (tenant_id, archive_id, key_version, status, failure_code)
       values ($1, app.uuid_v7(), 1, 'failed', 'store_unavailable')`,
      [failed.id],
    );
    const operator = '0190a000-0000-7000-8000-0000000000b1';
    const other = '0190a000-0000-7000-8000-0000000000b2';
    await admin.query(
      `insert into archive_release_request (target_tenant_id, requester_kind, requester_name, requester_email,
                                            scope_document_type, scope_document, reason, status, recorded_by,
                                            identity_verified_by, identity_verified_at, approved_by, approved_at,
                                            expires_at, identity_checklist)
       values ($1, 'patient', 'Ana Ríos', 'ana@ejemplo.test', 'dni', '20111222', 'Segunda opinión médica',
               'approved', $2, $2, now() - interval '30 minutes', $3, now() - interval '30 minutes',
               now() + interval '7 days',
               '{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb)`,
      [written.id, operator, other],
    );
    const unconfirmed = await createTestTenant(runtime, { slug: 'metrics-signup-unsent' });
    await admin.query(`update tenant set status = 'unverified' where id = $1`, [unconfirmed.id]);
    await admin.query(
      `insert into signup_pending (tenant_id, owner_email, owner_name, created_at)
       values ($1, 'sin-enviar@ejemplo.test', 'Ana', now() - interval '2 hours')`,
      [unconfirmed.id],
    );
    await admin.query('select app.releaser_beat(now())');
    await admin.query("update releaser_heartbeat set beat_at = now() - interval '10 seconds'");

    const measured = await fresh();
    const oracle = await ONE<Record<string, number | null>>('select * from app.platform_health()');

    expect(measured.get('archive_verify_problems', { status: 'corrupted' })).toBe(
      oracle['archive_verify_corrupted'],
    );
    expect(measured.get('archive_verify_problems', { status: 'corrupted' })).toBeGreaterThanOrEqual(
      1,
    );
    expect(measured.get('archive_write_failed')).toBe(oracle['archive_write_failed']);
    expect(measured.get('archive_write_failed')).toBeGreaterThanOrEqual(1);
    expect(measured.get('archive_verify_oldest_seconds')).toBeGreaterThanOrEqual(16 * 86_400);
    expect(measured.get('archive_release_approved_waiting')).toBe(
      oracle['release_approved_waiting'],
    );
    expect(measured.get('archive_release_approved_waiting')).toBeGreaterThanOrEqual(1);
    expect(measured.get('archive_release_approved_oldest_seconds')).toBeGreaterThanOrEqual(1800);
    expect(measured.get('signup_emails_unsent')).toBe(oracle['signup_unsent']);
    expect(measured.get('signup_emails_unsent')).toBeGreaterThanOrEqual(1);
    expect(measured.get('signup_oldest_unsent_seconds')).toBeGreaterThanOrEqual(7200);
    // The releaser wrote its heartbeat ten seconds ago: the age is a few seconds, and a minute is
    // more than enough of a margin for a slow machine.
    expect(measured.get('archive_releaser_heartbeat_age_seconds')).toBeGreaterThanOrEqual(10);
    expect(measured.get('archive_releaser_heartbeat_age_seconds')).toBeLessThan(120);
  });

  it('keeps the new series free of names, addresses and text of a person', async () => {
    const text = (await fresh()).render();

    expect(text).toContain('# TYPE subscriptions_parked gauge');
    expect(text).not.toMatch(/@|Ana R|ejemplo\.test|tenants\/x/i);
  });
});
