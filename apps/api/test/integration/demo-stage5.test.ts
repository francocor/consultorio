import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakePrescriptionProvider } from '../../src/adapters/erx-fake/index.js';
import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { resetDemoTenant } from '../../src/db/seed/demo/reset.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { snapshotDemoStage5 } from '../../src/db/seed/demo/stage5/snapshot.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * What the Stage 5 demo seed leaves in a demonstration organization (tasks 5.47 and 5.49; DEM-02,
 * DEM-03, DEM-04, DEM-05): a consent template with two versions and consents in every state, the
 * cardiologist's matricula verified (and nobody else's), prescriptions issued through the in-memory
 * fake, and a patient with portal access plus the representative of a minor. Two seeds give the
 * same content, nothing is sent, and a reset takes well under a minute.
 */

const RESET_LIMIT_MS = 60_000;

let runtime: DbHandle;
let operator: OperatorHarness;
let deps: DemoSeedDeps;
let provider: ReturnType<typeof createFakePrescriptionProvider>;
const clock = () => new Date('2026-03-02T12:00:00Z');
let first: string;
let second: string;

const rows = <T extends Record<string, unknown>>(tenantId: string, query: ReturnType<typeof sql>) =>
  deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const result = await tx.execute<T>(query);
    return result.rows;
  });

/**
 * Clinical rows (a prescription, a signature) are visible to a professional only: the query runs as
 * each professional of the organization and the rows are joined (a row two of them can read is
 * counted once).
 */
const clinicalRows = async <T extends Record<string, unknown>>(
  tenantId: string,
  query: ReturnType<typeof sql>,
) => {
  const team = await rows<{ id: string; user_id: string }>(
    tenantId,
    sql`SELECT p.id, m.user_id FROM professional p JOIN membership m ON m.id = p.membership_id`,
  );
  const seen = new Map<string, T>();
  for (const member of team) {
    const found = await deps.withTenant(
      { tenantId, userId: member.user_id, actingProfessionalId: member.id },
      async (tx) => (await tx.execute<T>(query)).rows,
    );
    for (const row of found) seen.set(JSON.stringify(row), row as T);
  }
  return [...seen.values()];
};

const count = async (tenantId: string, query: ReturnType<typeof sql>) =>
  Number((await rows<{ n: string | number }>(tenantId, query))[0]?.n ?? 0);

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  provider = createFakePrescriptionProvider();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
    documents: { storage: createMemoryObjectStorage(), scanner: createFakeScanner() },
    operatorDb: operator.db.db,
    prescriptionProvider: provider,
  };
  first = (await createTestTenant(runtime, { slug: 'stage5-a', isDemo: true, billingExempt: true }))
    .id;
  second = (
    await createTestTenant(runtime, { slug: 'stage5-b', isDemo: true, billingExempt: true })
  ).id;
  await seedDemoTenant(deps, first);
  await seedDemoTenant(deps, second);
}, 300_000);

afterAll(async () => {
  await operator.close();
  await runtime.close();
});

describe('the consents of the demonstration organization', () => {
  it('have a template with two versions, a second one with one, and a draft', async () => {
    const templates = await rows<{ title: string; status: string; versions: number }>(
      first,
      sql`SELECT t.title, t.status,
                 (SELECT count(*)::int FROM consent_template_version v WHERE v.template_id = t.id) AS versions
            FROM consent_template t ORDER BY t.title`,
    );

    expect(templates.map((template) => [template.status, template.versions]).sort()).toEqual([
      ['draft', 0],
      ['published', 1],
      ['published', 2],
    ]);
  });

  it('are in every state the services allow: pending, signed, declined and revoked', async () => {
    const byStatus = await rows<{ status: string; n: number }>(
      first,
      sql`SELECT status, count(*)::int AS n FROM consent_request GROUP BY 1`,
    );

    for (const status of ['pending', 'signed', 'declined', 'revoked']) {
      expect(byStatus.find((entry) => entry.status === status)?.n ?? 0, status).toBeGreaterThan(0);
    }
  });

  it('keep a signature and a revocation for the revoked one, bound to the first version of the template', async () => {
    const [revoked] = await rows<{
      id: string;
      version: number;
      versions: number;
      revocations: number;
      channel: string;
    }>(
      first,
      sql`SELECT r.id, v.version_number AS version,
                 (SELECT count(*)::int FROM consent_template_version w WHERE w.template_id = v.template_id) AS versions,
                 (SELECT count(*)::int FROM consent_revocation x WHERE x.request_id = r.id) AS revocations,
                 (SELECT x.channel FROM consent_revocation x WHERE x.request_id = r.id) AS channel
            FROM consent_request r
            JOIN consent_template_version v ON v.id = r.template_version_id
           WHERE r.status = 'revoked'
           ORDER BY r.created_at LIMIT 1`,
    );
    const signatures = await clinicalRows<{ request_id: string }>(
      first,
      sql`SELECT request_id FROM consent_signature`,
    );

    expect(revoked).toMatchObject({ version: 1, versions: 2, revocations: 1, channel: 'portal' });
    expect(signatures.filter((entry) => entry.request_id === revoked?.id)).toHaveLength(1);
  });

  it('include a portal request waiting for the signature of the patient, on the latest version', async () => {
    const [waiting] = await rows<{ version: number; latest: number }>(
      first,
      sql`SELECT v.version_number AS version,
                 (SELECT max(w.version_number) FROM consent_template_version w WHERE w.template_id = v.template_id) AS latest
            FROM consent_request r
            JOIN consent_template_version v ON v.id = r.template_version_id
           WHERE r.status = 'pending' AND r.method = 'portal'`,
    );

    expect(waiting?.version).toBe(2);
    expect(waiting?.latest).toBe(2);
  });

  it('include a consent of a minor signed by the representative, and a signature drawn by hand', async () => {
    const signers = await clinicalRows<{ id: string; signer_kind: string; method: string }>(
      first,
      sql`SELECT id, signer_kind, method FROM consent_signature`,
    );

    expect(signers.some((signature) => signature.signer_kind === 'representative')).toBe(true);
    expect(signers.some((signature) => signature.signer_kind === 'patient')).toBe(true);
    expect(signers.some((signature) => signature.method === 'portal')).toBe(true);
    expect(signers.some((signature) => signature.method === 'in_person')).toBe(true);
  });
});

describe('the prescriptions of the demonstration organization', () => {
  it('belong to the professional whose matricula the platform verified, and to nobody else', async () => {
    const verified = await rows<{ matricula: string; status: string }>(
      first,
      sql`SELECT matricula, matricula_status AS status FROM professional ORDER BY matricula`,
    );
    const authors = [
      ...new Set(
        (
          await clinicalRows<{ id: string; matricula: string }>(
            first,
            sql`SELECT r.id, p.matricula FROM prescription r JOIN professional p ON p.id = r.author_professional_id`,
          )
        ).map((entry) => entry.matricula),
      ),
    ];

    expect(verified).toEqual([
      { matricula: '188204', status: 'unverified' },
      { matricula: '41258', status: 'verified' },
      { matricula: '9117', status: 'unverified' },
    ]);
    expect(authors).toEqual(['41258']);
  });

  it('are issued, dispensed and cancelled, all simulated, and the issued ones are the fake provider’s', async () => {
    const all = await clinicalRows<{
      id: string;
      status: string;
      simulated: boolean;
      external_id: string | null;
    }>(first, sql`SELECT id, status, simulated, external_id FROM prescription`);
    const issued = all.filter((entry) => entry.external_id !== null) as {
      external_id: string;
    }[];

    for (const status of ['issued', 'dispensed', 'cancelled']) {
      expect(all.filter((entry) => entry.status === status).length, status).toBeGreaterThan(0);
    }
    expect(all.every((entry) => entry.simulated)).toBe(true);
    const held = new Set(provider.prescriptions().map((entry) => entry.externalId));
    expect(issued.length).toBeGreaterThan(2);
    for (const entry of issued) expect(held.has(entry.external_id), entry.external_id).toBe(true);
  });

  it('switch the connection of the organization on for the simulator', async () => {
    const [connection] = await rows<{ enabled: boolean; provider_key: string; status: string }>(
      first,
      sql`SELECT enabled, provider_key, status FROM erx_connection`,
    );

    expect(connection).toEqual({ enabled: true, provider_key: 'local', status: 'active' });
  });
});

describe('the portal of the demonstration organization', () => {
  it('gives a patient access to their own record and the representative of a minor access to the minor', async () => {
    const links = await rows<{ email: string; relationship: string; patient: string }>(
      first,
      sql`SELECT i.email, l.relationship, p.given_names || ' ' || p.family_name AS patient
            FROM portal_link l
            JOIN portal_identity i ON i.id = l.portal_identity_id
            JOIN patient p ON p.id = l.patient_id
           ORDER BY i.email`,
    );

    expect(links).toEqual([
      expect.objectContaining({
        email: 'paula.navarro@demo.invalid',
        relationship: 'representative',
        patient: 'Ian Navarro',
      }),
      expect.objectContaining({
        email: 'valentina.gomez@demo.invalid',
        relationship: 'self',
        patient: 'Valentina Gómez',
      }),
    ]);
  });

  it('has every identity active, and nobody signed in (a session lives hours and needs a code)', async () => {
    const statuses = await rows<{ status: string }>(
      first,
      sql`SELECT DISTINCT status FROM portal_identity`,
    );

    expect(statuses).toEqual([{ status: 'active' }]);
    expect(await count(first, sql`SELECT count(*)::int AS n FROM portal_session`)).toBe(0);
  });

  it('shares a document with the portal patient', async () => {
    const shares = await rows<{ name: string }>(
      first,
      sql`SELECT d.original_name AS name FROM document_share s JOIN document d ON d.id = s.document_id
           JOIN patient p ON p.id = s.patient_id WHERE p.family_name = 'Gómez'`,
    );

    expect(shares.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves no live activation link behind: the invitations were followed', async () => {
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM action_token
             WHERE kind = 'portal_activation' AND revoked_at IS NULL AND uses < max_uses`,
      ),
    ).toBe(0);
  });
});

describe('nothing leaves the process', () => {
  it('sends no email, queues no job and keeps nothing in the demo outbox', async () => {
    expect(
      await count(
        first,
        sql`SELECT count(*)::int AS n FROM demo_outbox WHERE target_tenant_id = ${first}::uuid`,
      ),
    ).toBe(0);
    expect(await count(first, sql`SELECT count(*)::int AS n FROM job_execution`)).toBe(0);
  });
});

describe('the seed is repeatable', () => {
  it('gives two organizations the same logical Stage 5 content', async () => {
    const a = await snapshotDemoStage5(deps.withTenant, first);
    const b = await snapshotDemoStage5(deps.withTenant, second);

    expect(a).toEqual(b);
    expect(a.templates).toHaveLength(3);
    expect(a.consents.length).toBeGreaterThanOrEqual(8);
    expect(a.prescriptions.length).toBeGreaterThanOrEqual(4);
    expect(a.portal).toHaveLength(2);
  });
});

describe('the reset with Stage 5 data', () => {
  it('finishes in well under a minute and gives back the same content, the verified matricula included', async () => {
    const before = await snapshotDemoStage5(deps.withTenant, first);

    const started = performance.now();
    await resetDemoTenant({ ...deps, operatorDb: operator.db.db }, first, { operatorId: null });
    const elapsed = performance.now() - started;

    process.stdout.write(`demo reset with Stage 5 data took ${String(Math.round(elapsed))} ms\n`);
    expect(elapsed).toBeLessThan(RESET_LIMIT_MS);
    expect(await snapshotDemoStage5(deps.withTenant, first)).toEqual(before);
    expect(before.matriculas.filter((entry) => entry.status === 'verified')).toHaveLength(1);
  }, 120_000);
});

describe('a seed run without the platform operator', () => {
  it('leaves every professional unverified and prescribes nothing, instead of failing', async () => {
    const id = (
      await createTestTenant(runtime, { slug: 'stage5-solo', isDemo: true, billingExempt: true })
    ).id;
    const withoutOperator: DemoSeedDeps = { ...deps, operatorDb: undefined };

    await seedDemoTenant(withoutOperator, id);

    expect(
      await count(
        id,
        sql`SELECT count(*)::int AS n FROM professional WHERE matricula_status = 'verified'`,
      ),
    ).toBe(0);
    expect(await clinicalRows(id, sql`SELECT id FROM prescription`)).toEqual([]);
    expect(await count(id, sql`SELECT count(*)::int AS n FROM consent_request`)).toBeGreaterThan(5);
  }, 240_000);
});
