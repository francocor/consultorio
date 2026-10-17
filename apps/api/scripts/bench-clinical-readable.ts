import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import { runMigrations } from '../src/db/migrate.js';
import { tenant } from '../src/db/schema/tenant.js';
import { createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../src/platform/db/tenant-context.js';
import { uuidv7 } from '../src/platform/db/uuid.js';

/**
 * Benchmark of the clinical row level security (task 2.97; design risk table: "`clinical_readable`
 * in RLS adds per-row cost"). It fills a throwaway Postgres 17 with `--notes` clinical notes
 * (default 100,000) and measures what the screens ask of the database, as the application role,
 * with the policies on:
 *
 *   1. the timeline of a patient the professional treats (the chart);
 *   2. the professional's drafts;
 *   3. the timeline of a patient the professional does NOT treat (every row filtered out);
 *
 * and, for comparison, the timeline without the policies (superuser). The targets are the budget of
 * a screen that must feel instant: p95 under 50 ms for each.
 *
 *   pnpm --filter @consultorio/api bench:clinical            # 100,000 notes
 *   pnpm --filter @consultorio/api bench:clinical --notes 5000   # a quick check of the script
 *
 * Needs Docker and nothing else. Prints a Markdown report (docs/perf/clinical-readable.md keeps one).
 */
const ROLES_SQL = new URL('../../../infra/postgres/init/01-roles.sql', import.meta.url);
const DATABASE = 'consultorio_bench';
const TARGET_P95_MS = 50;
/** The 2,000-entry chart returns forty times more rows: it gets a wider budget. */
const HEAVY_TARGET_P95_MS = 150;

const { values } = parseArgs({
  options: {
    notes: { type: 'string', default: '100000' },
    patients: { type: 'string', default: '20000' },
    samples: { type: 'string', default: '300' },
  },
});
const NOTES = Number(values.notes);
const PATIENTS = Number(values.patients);
const SAMPLES = Number(values.samples);
const PROFESSIONALS = 5;

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

const ms = (value: number) => value.toFixed(1);

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`[bench] ${line}\n`);
  log('starting Postgres');
  const container = await new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start();
  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${DATABASE}`;
  try {
    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
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

    log(`seeding ${String(NOTES)} notes for ${String(PATIENTS)} patients`);
    // Straight into the tables as the superuser with triggers and foreign keys off: the benchmark
    // measures reads, not the guards of the writes (those have their own tests).
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `CREATE TEMP TABLE bench_pros AS
         SELECT n AS n, app.uuid_v7() AS id FROM generate_series(1, ${String(PROFESSIONALS)}) n`,
    );
    await admin.query(
      `INSERT INTO professional (id, tenant_id, membership_id, specialties)
         SELECT id, '${tenantId}', app.uuid_v7(), ARRAY['general'] FROM bench_pros`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_patients AS
         SELECT n AS n, app.uuid_v7() AS id FROM generate_series(1, ${String(PATIENTS)}) n`,
    );
    await admin.query(
      `INSERT INTO patient (id, tenant_id, family_name, given_names, birth_date)
         SELECT id, '${tenantId}', 'Paciente' || n, 'Prueba', DATE '1980-01-01' + (n % 20000)
           FROM bench_patients`,
    );
    // Each patient is treated by two professionals (an assignment), like a center that shares care.
    await admin.query(
      `INSERT INTO care_relationship (tenant_id, patient_id, professional_id, assigned)
         SELECT '${tenantId}', p.id, pr.id, true
           FROM bench_patients p
           JOIN bench_pros pr ON pr.n IN ((p.n % ${String(PROFESSIONALS)}) + 1, ((p.n + 1) % ${String(PROFESSIONALS)}) + 1)`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_encounters AS
         SELECT n, app.uuid_v7() AS id,
                (SELECT id FROM bench_patients WHERE bench_patients.n = (g.n % ${String(PATIENTS)}) + 1) AS patient_id
           FROM generate_series(1, ${String(NOTES)}) AS g(n)`,
    );
    // The author is one of the two professionals that treat the patient.
    await admin.query(
      `CREATE TEMP TABLE bench_authors AS
         SELECT e.n, e.id AS encounter_id, e.patient_id,
                (SELECT pr.id FROM bench_pros pr
                  WHERE pr.n = ((p.n + (e.n % 2)) % ${String(PROFESSIONALS)}) + 1) AS author_id
           FROM bench_encounters e
           JOIN bench_patients p ON p.id = e.patient_id`,
    );
    await admin.query(
      `INSERT INTO encounter (id, tenant_id, patient_id, author_professional_id, template_kind, created_at)
         SELECT encounter_id, '${tenantId}', patient_id, author_id, 'general',
                now() - (n || ' minutes')::interval
           FROM bench_authors`,
    );
    await admin.query(
      `INSERT INTO clinical_note
           (tenant_id, encounter_id, patient_id, author_professional_id, status, template_kind,
            template_version, draft_content_enc, signed_at, created_at, updated_at)
         SELECT '${tenantId}', encounter_id, patient_id, author_id,
                CASE WHEN n % 50 = 0 THEN 'draft' ELSE 'signed' END, 'general', 1,
                CASE WHEN n % 50 = 0 THEN '\\x00'::bytea END,
                CASE WHEN n % 50 = 0 THEN NULL ELSE now() - (n || ' minutes')::interval END,
                now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval
           FROM bench_authors`,
    );
    // One patient with 2,000 entries (the window of the per-patient search, design 4.3), all read by
    // the professional: the heaviest chart a screen is asked to open.
    await admin.query(
      `CREATE TEMP TABLE bench_heavy AS
         SELECT n, app.uuid_v7() AS encounter_id FROM generate_series(1, 2000) n`,
    );
    await admin.query(
      `INSERT INTO encounter (id, tenant_id, patient_id, author_professional_id, template_kind, created_at)
         SELECT h.encounter_id, '${tenantId}', hp.id, pr.id, 'general', now() - (h.n || ' hours')::interval
           FROM bench_heavy h, (SELECT id FROM bench_patients WHERE n = 1) hp, (SELECT id FROM bench_pros WHERE n = 1) pr`,
    );
    await admin.query(
      `INSERT INTO clinical_note
           (tenant_id, encounter_id, patient_id, author_professional_id, status, template_kind,
            template_version, signed_at, created_at, updated_at)
         SELECT '${tenantId}', h.encounter_id, hp.id, pr.id, 'signed', 'general', 1,
                now() - (h.n || ' hours')::interval, now() - (h.n || ' hours')::interval, now() - (h.n || ' hours')::interval
           FROM bench_heavy h, (SELECT id FROM bench_patients WHERE n = 1) hp, (SELECT id FROM bench_pros WHERE n = 1) pr`,
    );
    await admin.query(
      `INSERT INTO care_relationship (tenant_id, patient_id, professional_id, assigned)
         SELECT '${tenantId}', hp.id, pr.id, true
           FROM (SELECT id FROM bench_patients WHERE n = 1) hp, (SELECT id FROM bench_pros WHERE n = 1) pr
         ON CONFLICT DO NOTHING`,
    );
    await admin.query('COMMIT');
    await admin.query('ANALYZE clinical_note');
    await admin.query('ANALYZE care_relationship');
    await admin.query('ANALYZE encounter');

    const professionals = (
      await admin.query<{ id: string; n: number }>(
        `SELECT id, 1 AS n FROM professional WHERE tenant_id = '${tenantId}' ORDER BY id`,
      )
    ).rows;
    const me = professionals[0]?.id;
    if (!me) throw new Error('no professional');
    const treated = (
      await admin.query<{ patient_id: string }>(
        `SELECT patient_id FROM care_relationship WHERE tenant_id = '${tenantId}' AND professional_id = '${me}' ORDER BY random() LIMIT ${String(SAMPLES)}`,
      )
    ).rows.map((row) => row.patient_id);
    const untreated = (
      await admin.query<{ id: string }>(
        `SELECT id FROM patient p WHERE tenant_id = '${tenantId}'
            AND NOT EXISTS (SELECT 1 FROM care_relationship r WHERE r.patient_id = p.id AND r.professional_id = '${me}')
          ORDER BY random() LIMIT ${String(Math.min(SAMPLES, 100))}`,
      )
    ).rows.map((row) => row.id);

    const context = { tenantId, userId: uuidv7(), actingProfessionalId: me };
    const timeIt = async (
      name: string,
      inputs: readonly string[],
      run: (tx: Tx, input: string) => Promise<unknown>,
    ): Promise<Stats> => {
      const timings: number[] = [];
      // One warm-up pass so plans and caches are the steady state a running application has.
      for (const input of inputs.slice(0, 5)) await withTenant(context, (tx) => run(tx, input));
      for (const input of inputs) {
        await withTenant(context, async (tx) => {
          const started = performance.now();
          await run(tx, input);
          timings.push(performance.now() - started);
        });
      }
      return stats(name, timings);
    };

    const timeline = (tx: Tx, patientId: string) =>
      tx.execute(
        sql`SELECT id, status, template_kind, created_at FROM clinical_note
             WHERE patient_id = ${patientId} ORDER BY created_at DESC LIMIT 50`,
      );
    const results: Stats[] = [];
    results.push(await timeIt('Timeline of a treated patient (RLS on)', treated, timeline));
    results.push(
      await timeIt('Drafts of the professional (RLS on)', ['drafts'], async (tx) =>
        tx.execute(
          sql`SELECT id FROM clinical_note WHERE status = 'draft' AND author_professional_id = ${me}
               ORDER BY updated_at DESC LIMIT 50`,
        ),
      ),
    );
    // The drafts list is one query: repeat it to get a distribution.
    const draftTimings: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      await withTenant(context, async (tx) => {
        const started = performance.now();
        await tx.execute(
          sql`SELECT id FROM clinical_note WHERE status = 'draft' AND author_professional_id = ${me}
               ORDER BY updated_at DESC LIMIT 50`,
        );
        draftTimings.push(performance.now() - started);
      });
    }
    results[1] = stats('Drafts of the professional (RLS on)', draftTimings);
    results.push(
      await timeIt(
        'Timeline of a patient NOT treated (RLS filters every row)',
        untreated,
        timeline,
      ),
    );

    const heavyPatient = (
      await admin.query<{ id: string }>(
        `SELECT patient_id AS id FROM clinical_note WHERE tenant_id = '${tenantId}'
          GROUP BY patient_id ORDER BY count(*) DESC LIMIT 1`,
      )
    ).rows[0]?.id;
    const heavyTimings: number[] = [];
    for (let index = 0; index < Math.min(SAMPLES, 100); index += 1) {
      await withTenant(context, async (tx) => {
        const started = performance.now();
        await tx.execute(
          sql`SELECT id, status, template_kind, created_at FROM clinical_note
               WHERE patient_id = ${heavyPatient ?? ''} ORDER BY created_at DESC LIMIT 2000`,
        );
        heavyTimings.push(performance.now() - started);
      });
    }
    results.push(stats('A chart of 2,000 entries, all of them read (RLS on)', heavyTimings));

    const baseline: number[] = [];
    for (const patientId of treated) {
      const started = performance.now();
      await admin.query(
        `SELECT id, status, template_kind, created_at FROM clinical_note
          WHERE tenant_id = $1 AND patient_id = $2 ORDER BY created_at DESC LIMIT 50`,
        [tenantId, patientId],
      );
      baseline.push(performance.now() - started);
    }
    results.push(stats('Timeline of a treated patient (no policies, superuser)', baseline));

    // The plan of the first query, for the record.
    const sample = treated[0] ?? '';
    const plan = await withTenant(context, (tx) =>
      tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, status, template_kind, created_at
              FROM clinical_note WHERE patient_id = ${sample} ORDER BY created_at DESC LIMIT 50`,
      ),
    );

    const total = (await admin.query<{ n: string }>(`SELECT count(*) AS n FROM clinical_note`))
      .rows[0]?.n;
    const version = (
      await admin.query<{ v: string }>("SELECT current_setting('server_version') AS v")
    ).rows[0]?.v;
    const lines = [
      `Clinical notes: ${total ?? '?'} in ${String(PATIENTS)} patients, ${String(PROFESSIONALS)} professionals (each patient treated by two). Postgres ${version ?? '?'}.`,
      '',
      '| Query | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 |',
      '|---|---|---|---|---|---|',
      ...results.map(
        (row, index) =>
          `| ${row.name} | ${String(row.samples)} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.max)} | ${index < 3 ? `< ${String(TARGET_P95_MS)}` : index === 3 ? `< ${String(HEAVY_TARGET_P95_MS)}` : 'reference'} |`,
      ),
      '',
      'Plan of the first query (RLS on):',
      '',
      '```',
      ...plan.rows.map((row) => row['QUERY PLAN']),
      '```',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    const missed = results
      .slice(0, 4)
      .filter((row, index) => row.p95 >= (index === 3 ? HEAVY_TARGET_P95_MS : TARGET_P95_MS));
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
