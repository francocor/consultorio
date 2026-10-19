import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { runMigrations } from '../src/db/migrate.js';
import { tenant } from '../src/db/schema/tenant.js';
import {
  chargeFactsStatement,
  paymentFactsStatement,
} from '../src/modules/billing/application/report-facts.js';
import { chargeFacts, paymentFacts } from '../src/modules/billing/index.js';
import { readInvoicedLines } from '../src/modules/invoicing/index.js';
import { cashReport } from '../src/modules/reports/application/cash-report.js';
import { financialRecords, financialReport } from '../src/modules/reports/application/financial.js';
import {
  operationalRecords,
  operationalReport,
} from '../src/modules/reports/application/operational.js';
import type { ReportScope } from '../src/modules/reports/application/scope.js';
import { availableMinutes, operationalFacts } from '../src/modules/scheduling/index.js';
import type { TenantKeys } from '../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';
import { uuidv7 } from '../src/platform/db/uuid.js';

/**
 * Benchmark of the operational reports (task 4.31) and the financial and cash reports (task 4.57 to
 * 4.58; design, "Reporting": read models over indexed
 * tables, target p95 under 1 s). It fills a throwaway Postgres 17 with `--appointments` appointments
 * (default 50,000, spread over the year 2025, with a history of moves and confirmations and working
 * hours for twenty professionals) and times, as the application role with the policies on, what the
 * dashboard asks of the database through the same functions the routes call:
 *
 *   1. the report of a month for the whole organization;
 *   2. the report of the whole year for the whole organization;
 *   3. the report of a month for reception of one location;
 *   4. the report of a month for one professional;
 *   5. a page of the drill-down of a month, and of the no-shows of the year;
 *   6. the financial report of a month and of a year (charges, payments, refunds and vouchers),
 *      for the organization, reception and a professional, and a page of its drill-downs;
 *   7. the cash report of a month and of a year.
 *
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts                 # 50,000
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --appointments 5000
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --no-indexes    # without 0430 and 0431
 *
 * Needs Docker and nothing else. Prints a Markdown report (docs/perf/reports.md keeps one). The exit
 * code is 1 when a target is missed, so it can gate a release.
 */
const ROLES_SQL = new URL('../../../infra/postgres/init/01-roles.sql', import.meta.url);
const DATABASE = 'consultorio_bench';
const TARGET_P95_MS = 1000;
const PROFESSIONALS = 20;
const LOCATIONS = 3;
const PATIENTS = 5000;

const { values } = parseArgs({
  options: {
    appointments: { type: 'string', default: '50000' },
    samples: { type: 'string', default: '20' },
    'no-indexes': { type: 'boolean', default: false },
    explain: { type: 'boolean', default: false },
  },
});
const APPOINTMENTS = Number(values.appointments);
const SAMPLES = Number(values.samples);
const WITHOUT_INDEXES = values['no-indexes'];

const YEAR = { from: '2025-01-01', to: '2025-12-31' };
const MONTH = { from: '2025-06-01', to: '2025-06-30' };

/** The indexes the financial reports added (migration 0431); dropped by `--no-indexes`. */
const MONEY_INDEXES: readonly string[] = [
  'charge_report_idx',
  'payment_report_idx',
  'payment_reversal_report_idx',
  'invoice_report_idx',
];

/**
 * The money of the year 2025, on top of the appointments: a charge for each attended appointment (one
 * in five for a payer, which splits it in a copago and the payer's part; one in fifty voided), a
 * payment for six in seven of the others, a partial refund for one payment in thirty, a register
 * for every location and day, a voucher for two in five of the private charges and a credit note for
 * some of those. Straight into the tables as the superuser with triggers and foreign keys off: the
 * benchmark measures reads, and the guards of the writes have their own tests.
 */
async function seedMoney(admin: pg.Client, tenantId: string): Promise<void> {
  const q = (sql: string) => admin.query(sql.replaceAll('$TENANT', `'${tenantId}'::uuid`));
  const zone = "'America/Argentina/Buenos_Aires'";
  await q(`CREATE TEMP TABLE bench_payers AS
             SELECT n, app.uuid_v7() AS id FROM generate_series(1, 3) n`);
  await q(`INSERT INTO tenant_payer (id, tenant_id, custom_name)
             SELECT id, $TENANT, 'Obra social ' || n FROM bench_payers`);
  await q(`CREATE TEMP TABLE bench_sessions AS
             SELECT l.id AS location_id, d::date AS day, app.uuid_v7() AS id
               FROM bench_locations l
               CROSS JOIN generate_series(DATE '2025-01-01', DATE '2025-12-31', interval '1 day') d`);
  await q(`INSERT INTO cash_session
               (id, tenant_id, location_id, status, opened_by, opened_at, opening_cents,
                closed_by, closed_at, expected_cents, counted_cents, difference_cents)
             SELECT id, $TENANT, location_id, 'closed', app.uuid_v7(),
                    (day + time '09:00') AT TIME ZONE ${zone}, 1000000,
                    app.uuid_v7(), (day + time '19:00') AT TIME ZONE ${zone}, 5000000, 5000000, 0
               FROM bench_sessions`);

  await q(`CREATE TEMP TABLE bench_charges AS
             SELECT app.uuid_v7() AS id, a.id AS appointment_id, a.patient_id, a.professional_id,
                    a.location_id, a.starts_at, b.n,
                    CASE WHEN b.n % 5 = 0
                         THEN (SELECT id FROM bench_payers WHERE bench_payers.n = (b.n % 3) + 1) END
                      AS tenant_payer_id,
                    (b.n % 50 = 1) AS voided,
                    (a.starts_at AT TIME ZONE ${zone})::date AS day
               FROM bench_appointments b JOIN appointment a ON a.id = b.id
              WHERE a.status = 'attended'`);
  await q(`INSERT INTO charge
               (id, tenant_id, appointment_id, patient_id, professional_id, location_id,
                tenant_payer_id, status, snapshot, captured_by, void_reason, voided_at)
             SELECT id, $TENANT, appointment_id, patient_id, professional_id, location_id,
                    tenant_payer_id,
                    CASE WHEN voided THEN 'voided' WHEN n % 7 = 0 THEN 'pending' ELSE 'paid' END,
                    jsonb_build_object('appointmentTypeName', 'Consulta', 'serviceDate', day::text,
                                       'quote', NULL, 'explicitAmountCents', NULL),
                    app.uuid_v7(),
                    CASE WHEN voided THEN 'Cargado por error' END,
                    CASE WHEN voided THEN starts_at END
               FROM bench_charges`);
  await q(`CREATE TEMP TABLE bench_lines AS
             SELECT app.uuid_v7() AS id, id AS charge_id, 1 AS position, 'patient' AS portion,
                    CASE WHEN tenant_payer_id IS NULL THEN 'service' ELSE 'copago' END AS kind,
                    CASE WHEN tenant_payer_id IS NULL THEN 2000000 + (n % 5) * 100000 ELSE 300000 END
                      AS amount_cents
               FROM bench_charges
             UNION ALL
             SELECT app.uuid_v7(), id, 2, 'payer', 'payer_coverage', 1500000
               FROM bench_charges WHERE tenant_payer_id IS NOT NULL`);
  await q(`INSERT INTO charge_line (id, tenant_id, charge_id, position, kind, portion, description, amount_cents)
             SELECT id, $TENANT, charge_id, position, kind, portion, 'Consulta', amount_cents
               FROM bench_lines`);

  await q(`CREATE TEMP TABLE bench_payments AS
             SELECT app.uuid_v7() AS id, c.id AS charge_id, c.location_id, c.starts_at, c.n, c.day,
                    CASE WHEN c.n % 10 < 2 THEN 'transfer' WHEN c.n % 10 < 4 THEN 'credit'
                         WHEN c.n % 10 < 7 THEN 'debit' ELSE 'cash' END AS method,
                    l.amount_cents
               FROM bench_charges c
               JOIN bench_lines l ON l.charge_id = c.id AND l.portion = 'patient'
              WHERE NOT c.voided AND c.n % 7 <> 0`);
  await q(`INSERT INTO payment
               (id, tenant_id, charge_id, location_id, cash_session_id, method, amount_cents,
                paid_at, recorded_by, idempotency_key, request_hash)
             SELECT p.id, $TENANT, p.charge_id, p.location_id, s.id, p.method, p.amount_cents,
                    p.starts_at + interval '2 hours', app.uuid_v7(), 'bench-pay-' || p.n, 'hash'
               FROM bench_payments p
               LEFT JOIN bench_sessions s ON s.location_id = p.location_id AND s.day = p.day`);
  await q(`INSERT INTO payment_reversal
               (id, tenant_id, payment_id, charge_id, location_id, cash_session_id, amount_cents,
                reason, kind, reversed_by, reversed_at, idempotency_key, request_hash)
             SELECT app.uuid_v7(), $TENANT, p.id, p.charge_id, p.location_id, s.id,
                    p.amount_cents / 10, 'Devolución parcial', 'refund', app.uuid_v7(),
                    p.starts_at + interval '1 day', 'bench-rev-' || p.n, 'hash'
               FROM bench_payments p
               LEFT JOIN bench_sessions s ON s.location_id = p.location_id AND s.day = p.day
              WHERE p.n % 30 = 0`);

  await q(`CREATE TEMP TABLE bench_invoices AS
             SELECT app.uuid_v7() AS id, c.id AS charge_id, c.patient_id, c.location_id, c.day, c.n,
                    row_number() OVER (ORDER BY c.n) AS number,
                    (SELECT sum(l.amount_cents) FROM bench_lines l
                      WHERE l.charge_id = c.id AND l.portion = 'patient') AS total
               FROM bench_charges c
              WHERE NOT c.voided AND c.tenant_payer_id IS NULL AND c.n % 5 IN (1, 2)`);
  await q(`CREATE TEMP TABLE bench_notes AS
             SELECT app.uuid_v7() AS id, i.id AS invoice_id, i.charge_id, i.patient_id, i.location_id,
                    i.day, i.n, i.number + 1000000 AS number, i.total / 2 AS total
               FROM bench_invoices i WHERE i.n % 20 = 1`);
  await q(`INSERT INTO invoice
               (id, tenant_id, type, point_of_sale, number, status, cae, cae_expires_on, issue_date,
                environment, idempotency_key, request_hash, recipient_kind, patient_id,
                recipient_tax_condition, total_cents, net_cents, location_ids, created_by,
                issued_at, credit_note_of_id, reason)
             SELECT id, $TENANT, 'FC', 1, number, 'issued', lpad(number::text, 14, '0'), day + 10, day,
                    'homologation', 'bench-inv-' || n, 'hash', 'patient', patient_id,
                    'consumidor_final', total, total, ARRAY[location_id], app.uuid_v7(), now(),
                    NULL::uuid, NULL
               FROM bench_invoices
             UNION ALL
             SELECT id, $TENANT, 'NCC', 1, number, 'issued', lpad(number::text, 14, '0'), day + 13,
                    day + 3, 'homologation', 'bench-note-' || n, 'hash', 'patient', patient_id,
                    'consumidor_final', total, total, ARRAY[location_id], app.uuid_v7(), now(),
                    invoice_id, 'Anulación parcial'
               FROM bench_notes`);
  await q(`INSERT INTO invoice_line
               (id, tenant_id, invoice_id, charge_line_id, charge_id, position, description, amount_cents)
             SELECT app.uuid_v7(), $TENANT, i.id, l.id, i.charge_id, l.position, 'Consulta', l.amount_cents
               FROM bench_invoices i
               JOIN bench_lines l ON l.charge_id = i.charge_id AND l.portion = 'patient'
             UNION ALL
             SELECT app.uuid_v7(), $TENANT, n.id, l.id, n.charge_id, l.position, 'Consulta', n.total
               FROM bench_notes n
               JOIN bench_lines l ON l.charge_id = n.charge_id AND l.portion = 'patient'`);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

interface Stats {
  name: string;
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(name: string, timings: number[]): Stats {
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    name,
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

const ms = (value: number) => value.toFixed(0);

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`[bench] ${line}\n`);
  log('starting Postgres');
  const container = await new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start();
  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${DATABASE}`;
  try {
    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
    // The container is stopped in `finally`; a late connection error must not hide the real one.
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(await readFile(ROLES_SQL, 'utf8'));
    log('migrating');
    await runMigrations(url('app_owner', 'app_owner_dev_only'));

    const runtime = createRuntimeDb(url('app_rw', 'app_rw_dev_only'));
    const withTenant = createWithTenant(runtime.db);
    const tenantId = uuidv7();
    await withTenant({ tenantId, userId: uuidv7() }, (tx) =>
      tx.insert(tenant).values({ id: tenantId, slug: 'bench' }),
    );

    log(`seeding ${String(APPOINTMENTS)} appointments`);
    // Straight into the tables as the superuser with triggers and foreign keys off: the benchmark
    // measures reads, not the guards of the writes (those have their own tests).
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `CREATE TEMP TABLE bench_locations AS
         SELECT n, app.uuid_v7() AS id FROM generate_series(1, ${String(LOCATIONS)}) n`,
    );
    await admin.query(
      `INSERT INTO location (id, tenant_id, name, time_zone)
         SELECT id, '${tenantId}', 'Sede ' || n, 'America/Argentina/Buenos_Aires' FROM bench_locations`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_pros AS
         SELECT n, app.uuid_v7() AS id, app.uuid_v7() AS membership_id
           FROM generate_series(1, ${String(PROFESSIONALS)}) n`,
    );
    await admin.query(
      `INSERT INTO membership (id, tenant_id, user_id, roles, display_name)
         SELECT membership_id, '${tenantId}', app.uuid_v7(), ARRAY['professional'], 'Profesional ' || n
           FROM bench_pros`,
    );
    await admin.query(
      `INSERT INTO professional (id, tenant_id, membership_id, specialties)
         SELECT id, '${tenantId}', membership_id,
                CASE WHEN n % 2 = 0 THEN ARRAY['clinica'] ELSE ARRAY['pediatria', 'clinica'] END
           FROM bench_pros`,
    );
    await admin.query(
      `INSERT INTO professional_hours (tenant_id, professional_id, location_id, weekday, start_minute, end_minute)
         SELECT '${tenantId}', p.id, l.id, d, h.start_minute, h.end_minute
           FROM bench_pros p
           JOIN bench_locations l ON l.n = (p.n % ${String(LOCATIONS)}) + 1
           CROSS JOIN generate_series(1, 5) d
           CROSS JOIN (VALUES (540, 780), (840, 1080)) AS h(start_minute, end_minute)`,
    );
    await admin.query(
      `INSERT INTO appointment_type (id, tenant_id, name, duration_minutes)
         VALUES (app.uuid_v7(), '${tenantId}', 'Consulta', 30)`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_patients AS
         SELECT n, app.uuid_v7() AS id FROM generate_series(1, ${String(PATIENTS)}) n`,
    );
    await admin.query(
      `INSERT INTO patient (id, tenant_id, family_name, given_names, birth_date)
         SELECT id, '${tenantId}', 'Paciente' || n, 'Prueba', DATE '1980-01-01' + (n % 20000)
           FROM bench_patients`,
    );
    // The appointments of 2025: a status mix like a real center (70% attended, 10% no-show, 10%
    // cancelled, the rest still open), 30% booked online, spread over the days, professionals and
    // the quarter hours of the working day.
    await admin.query(
      `CREATE TEMP TABLE bench_appointments AS
         SELECT n, app.uuid_v7() AS id,
                (DATE '2025-01-01' + (n % 365)) + ((9 * 60 + (n / 365) % 36 * 15) || ' minutes')::interval AS local_start
           FROM generate_series(1, ${String(APPOINTMENTS)}) n`,
    );
    await admin.query(
      `INSERT INTO appointment
           (id, tenant_id, patient_id, professional_id, location_id, appointment_type_id,
            starts_at, ends_at, status, source)
         SELECT a.id, '${tenantId}',
                (SELECT id FROM bench_patients WHERE bench_patients.n = (a.n % ${String(PATIENTS)}) + 1),
                p.id, l.id, (SELECT id FROM appointment_type WHERE tenant_id = '${tenantId}' LIMIT 1),
                a.local_start AT TIME ZONE 'America/Argentina/Buenos_Aires',
                (a.local_start + interval '30 minutes') AT TIME ZONE 'America/Argentina/Buenos_Aires',
                CASE WHEN a.n % 100 < 70 THEN 'attended'
                     WHEN a.n % 100 < 80 THEN 'no_show'
                     WHEN a.n % 100 < 90 THEN 'cancelled'
                     WHEN a.n % 100 < 95 THEN 'scheduled' ELSE 'confirmed' END,
                CASE WHEN a.n % 10 < 3 THEN 'online' WHEN a.n % 50 = 7 THEN 'waitlist_offer' ELSE 'staff' END
           FROM bench_appointments a
           JOIN bench_pros p ON p.n = (a.n % ${String(PROFESSIONALS)}) + 1
           JOIN bench_locations l ON l.n = (p.n % ${String(LOCATIONS)}) + 1`,
    );
    await admin.query(
      `INSERT INTO appointment_event (tenant_id, appointment_id, kind, to_status, actor_kind)
         SELECT '${tenantId}'::uuid, id, 'created', 'scheduled', 'staff' FROM bench_appointments
         UNION ALL
         SELECT '${tenantId}'::uuid, id, 'rescheduled', NULL, 'staff' FROM bench_appointments WHERE n % 10 = 0
         UNION ALL
         SELECT '${tenantId}'::uuid, id, 'status_changed', 'confirmed', 'patient' FROM bench_appointments WHERE n % 3 = 0`,
    );
    await seedMoney(admin, tenantId);
    await admin.query('COMMIT');
    if (WITHOUT_INDEXES) {
      log('dropping the indexes of migrations 0430 and 0431');
      await admin.query(
        'DROP INDEX appointment_report_idx, appointment_event_moved_idx, appointment_event_patient_confirmed_idx',
      );
      if (MONEY_INDEXES.length > 0) {
        await admin.query(`DROP INDEX IF EXISTS ${MONEY_INDEXES.join(', ')}`);
      }
    }
    for (const table of [
      'appointment',
      'appointment_event',
      'professional_hours',
      'patient',
      'charge',
      'charge_line',
      'payment',
      'payment_reversal',
      'cash_session',
      'invoice',
      'invoice_line',
    ]) {
      await admin.query(`ANALYZE ${table}`);
    }

    const professionalIds = (
      await admin.query<{ id: string }>(
        `SELECT id FROM professional WHERE tenant_id = '${tenantId}' ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const locationIds = (
      await admin.query<{ id: string }>(
        `SELECT id FROM location WHERE tenant_id = '${tenantId}' ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const someone = professionalIds[0] ?? '';
    const somewhere = locationIds[0] ?? '';

    const keys = {} as TenantKeys;
    const clock = () => new Date('2026-10-17T12:00:00.000Z');
    const context = { tenantId, userId: uuidv7() };
    const organization: ReportScope = { kind: 'organization' };
    const reception: ReportScope = {
      kind: 'locations',
      locationIds: [somewhere],
      professionalIds: [],
    };
    const professional: ReportScope = { kind: 'professional', professionalId: someone };

    const timeIt = async (name: string, run: () => Promise<unknown>): Promise<Stats> => {
      // Warm-up passes so plans and caches are the steady state of a running application.
      for (let pass = 0; pass < 3; pass += 1) await run();
      const timings: number[] = [];
      for (let pass = 0; pass < SAMPLES; pass += 1) {
        const started = performance.now();
        await run();
        timings.push(performance.now() - started);
      }
      return stats(name, timings);
    };
    const report = (scope: ReportScope, range: { from: string; to: string }) => () =>
      withTenant(context, (tx) =>
        operationalReport(tx, { scope, filters: range }, { keys, clock }),
      );
    const records =
      (scope: ReportScope, range: { from: string; to: string }, group: 'all' | 'no_show') => () =>
        withTenant(context, (tx) =>
          operationalRecords(tx, {
            scope,
            query: { ...range, group, limit: 50, offset: 0 },
          }),
        );

    const cohort = (range: { from: string; to: string }) => ({
      fromDate: range.from,
      toDate: range.to,
      scope: { kind: 'all' as const },
    });
    const results: Stats[] = [];
    results.push(
      await timeIt('Report of a month, whole organization', report(organization, MONTH)),
    );
    results.push(await timeIt('Report of a year, whole organization', report(organization, YEAR)));
    results.push(
      await timeIt('Report of a month, reception of one location', report(reception, MONTH)),
    );
    results.push(await timeIt('Report of a month, one professional', report(professional, MONTH)));
    results.push(
      await timeIt('Drill-down page of 50, a month (all)', records(organization, MONTH, 'all')),
    );
    results.push(
      await timeIt(
        'Drill-down page of 50, no-shows of a year',
        records(organization, YEAR, 'no_show'),
      ),
    );

    // The financial and cash reports (S4.14), through the functions the routes call.
    const money = (scope: ReportScope, range: { from: string; to: string }) => () =>
      withTenant(context, (tx) => financialReport(tx, { scope, filters: range }, { clock }));
    const moneyRecords =
      (
        scope: ReportScope,
        range: { from: string; to: string },
        kind: 'charged' | 'collected' | 'invoiced',
      ) =>
      () =>
        withTenant(context, (tx) =>
          financialRecords(tx, { scope, query: { ...range, kind, limit: 50, offset: 0 } }),
        );
    const cash = (scope: ReportScope, range: { from: string; to: string }) => () =>
      withTenant(context, (tx) => cashReport(tx, { scope, filters: range }, { clock }));
    results.push(
      await timeIt('Financial report of a month, whole organization', money(organization, MONTH)),
    );
    results.push(
      await timeIt('Financial report of a year, whole organization', money(organization, YEAR)),
    );
    results.push(
      await timeIt(
        'Financial report of a month, reception of one location',
        money(reception, MONTH),
      ),
    );
    results.push(
      await timeIt('Financial report of a month, one professional', money(professional, MONTH)),
    );
    results.push(
      await timeIt(
        'Financial drill-down page of 50, charges of a month',
        moneyRecords(organization, MONTH, 'charged'),
      ),
    );
    results.push(
      await timeIt(
        'Financial drill-down page of 50, payments of a year',
        moneyRecords(organization, YEAR, 'collected'),
      ),
    );
    results.push(
      await timeIt(
        'Financial drill-down page of 50, vouchers of a year',
        moneyRecords(organization, YEAR, 'invoiced'),
      ),
    );
    results.push(
      await timeIt('Cash report of a month, whole organization', cash(organization, MONTH)),
    );
    results.push(
      await timeIt('Cash report of a year, whole organization', cash(organization, YEAR)),
    );
    results.push(
      await timeIt('Cash report of a month, reception of one location', cash(reception, MONTH)),
    );
    // Where the time goes in the report of a year: the charges, the payments and the vouchers.
    const moneyCohort = { fromDate: YEAR.from, toDate: YEAR.to, scope: { kind: 'all' as const } };
    results.push(
      await timeIt('  of which the charges of a year', () =>
        withTenant(context, (tx) => chargeFacts(tx, moneyCohort)),
      ),
    );
    results.push(
      await timeIt('  of which the payments of a year', () =>
        withTenant(context, (tx) => paymentFacts(tx, moneyCohort)),
      ),
    );
    results.push(
      await timeIt('  of which the vouchers of a year', () =>
        withTenant(context, (tx) => readInvoicedLines(tx, YEAR)),
      ),
    );

    // Where the time goes: the counts of the appointments, and the working hours of the period.
    results.push(
      await timeIt('  of which the counts of a year', () =>
        withTenant(context, (tx) =>
          operationalFacts(tx, cohort(YEAR), { now: clock(), recoveredIds: [] }),
        ),
      ),
    );
    results.push(
      await timeIt('  of which the available time of a year', () =>
        withTenant(context, (tx) => availableMinutes(tx, cohort(YEAR), { keys })),
      ),
    );

    if (values.explain) {
      // The plans of the two heaviest statements of a year, as the superuser (the plan, not the policies).
      const dialect = new PgDialect();
      const wholeYear = {
        fromDate: YEAR.from,
        toDate: YEAR.to,
        scope: { kind: 'all' as const },
      };
      for (const [name, statement] of [
        ['charges of a year', chargeFactsStatement(wholeYear)],
        ['payments of a year', paymentFactsStatement(wholeYear)],
      ] as const) {
        const built = dialect.sqlToQuery(statement);
        await admin.query(`SET app.tenant_id = '${tenantId}'`).catch(() => undefined);
        const plan = await admin.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${built.sql}`,
          built.params,
        );
        process.stdout.write(
          `\n### Plan: ${name}\n\n\`\`\`\n${plan.rows.map((row) => row['QUERY PLAN']).join('\n')}\n\`\`\`\n`,
        );
      }
    }
    const total = (await admin.query<{ n: string }>('SELECT count(*) AS n FROM appointment'))
      .rows[0]?.n;
    const month = (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM appointment WHERE starts_at >= '2025-06-01' AND starts_at < '2025-07-01'`,
      )
    ).rows[0]?.n;
    const counts = (
      await admin.query<{ charges: string; payments: string; refunds: string; vouchers: string }>(
        `SELECT (SELECT count(*) FROM charge) AS charges, (SELECT count(*) FROM payment) AS payments,
                (SELECT count(*) FROM payment_reversal) AS refunds,
                (SELECT count(*) FROM invoice) AS vouchers`,
      )
    ).rows[0];
    const version = (
      await admin.query<{ v: string }>("SELECT current_setting('server_version') AS v")
    ).rows[0]?.v;
    const used = (
      await admin.query<{ indexrelname: string; idx_scan: string }>(
        `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
          WHERE indexrelname IN ('appointment_report_idx', 'appointment_event_moved_idx', 'appointment_event_patient_confirmed_idx')
          ORDER BY indexrelname`,
      )
    ).rows;
    const lines = [
      `Money: ${counts?.charges ?? '?'} charges, ${counts?.payments ?? '?'} payments, ${counts?.refunds ?? '?'} refunds, ${counts?.vouchers ?? '?'} vouchers (invoices and credit notes), one register per location and day.`,
      '',
      `Appointments: ${total ?? '?'} in the year 2025 (${month ?? '?'} in the month measured), ${String(PROFESSIONALS)} professionals, ${String(LOCATIONS)} locations. ${WITHOUT_INDEXES ? 'Migration 0430 and 0431 indexes dropped.' : 'With the indexes of migrations 0430 and 0431.'} Postgres ${version ?? '?'}.`,
      '',
      '| Query | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 |',
      '|---|---|---|---|---|---|',
      ...results.map(
        (row) =>
          `| ${row.name} | ${String(row.samples)} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.max)} | ${row.name.startsWith(' ') ? 'reference' : `< ${String(TARGET_P95_MS)}`} |`,
      ),
      '',
      `Scans of the new indexes during the run: ${used.length === 0 ? 'none (dropped)' : used.map((row) => `${row.indexrelname} ${row.idx_scan}`).join(', ')}.`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    const missed = results.filter((row) => !row.name.startsWith(' ') && row.p95 >= TARGET_P95_MS);
    if (missed.length > 0) {
      process.stdout.write(`\nTARGET MISSED: ${missed.map((row) => row.name).join('; ')}\n`);
      process.exitCode = 1;
    }
    await runtime.close();
    await admin.end();
  } finally {
    await container.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : 'failed'}\n`);
  process.exit(1);
});
