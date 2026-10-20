import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeArchiveStore,
  type FakeArchiveStore,
} from '../../src/adapters/archive-fake/index.js';
import { archiveKey, tenantArchive } from '../../src/db/schema/archive-key.js';
import { tenant } from '../../src/db/schema/tenant.js';
import {
  generateReleaserKeys,
  openObject,
  unwrapPrivateKey,
} from '../../src/modules/tenancy/archive/archive-crypto.js';
import {
  enqueueDueArchives,
  enqueueDueVerifications,
} from '../../src/modules/tenancy/archive/due.js';
import {
  createArchiveKeyReleaser,
  createArchiveKeyWriter,
} from '../../src/modules/tenancy/archive/keys.js';
import { parseManifest } from '../../src/modules/tenancy/archive/manifest.js';
import type { ArchiveStore } from '../../src/modules/tenancy/archive/ports.js';
import { restoreParts } from '../../src/modules/tenancy/archive/restore.js';
import {
  ARCHIVE_VERIFY_JOB,
  createArchiveVerifyJob,
} from '../../src/modules/tenancy/archive/verify-archive.js';
import {
  ARCHIVE_WRITE_JOB,
  createArchiveWriteJob,
} from '../../src/modules/tenancy/archive/write-archive.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import type { Professional } from '../support/clinical-world.js';
import { createRecordingJobClient } from '../support/jobs.js';
import { createRetentionWorld, type RetentionWorld } from '../support/retention-world.js';
import { asTenant } from '../support/tenants.js';
import { allTextOf, readZip } from '../support/zip-reader.js';

/**
 * The retention archive (tenancy, "Retention archive after cancellation"): after the export window the
 * records of a cancelled organization are written, encrypted, to the write-once store, verified, and
 * kept. This goes through the real database and the real contributors, with the in-memory store (the
 * store itself is proven against MinIO in `archive-local.test.ts` and `archive-immutability.test.ts`).
 */

let runtime: DbHandle;
let org: RetentionWorld;
let doctorA: Professional;
let doctorB: Professional;
let departed: Professional;
let store: FakeArchiveStore;
let releaser: { kek: string; publicKey: string };
let scratch: string;

const NOTE_A = 'Lumbalgia crónica de la paciente de A';
const NOTE_B = 'Migraña con aura del paciente de B';
const NOTE_DEPARTED = 'Seguimiento de quien se fue de la organización';
const ANAMNESIS_A = 'Alergia a la penicilina anotada por A';
const DAY = 86_400_000;

const entry = (text: string) => ({ reasonForConsultation: text });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** "Now" for the archive jobs: after the window of thirty days from the cancellation. */
let jobNow = new Date();

function stores(): { store: ArchiveStore } {
  return { store };
}

function writeJob(overrides: Partial<Parameters<typeof createArchiveWriteJob>[0]> = {}) {
  const withTenant = createWithTenant(runtime.db);
  return createArchiveWriteJob({
    exports: org.exports,
    withTenant,
    storage: org.storage,
    ...stores(),
    keys: createArchiveKeyWriter({ withTenant, releaserPublicKey: releaser.publicKey }),
    clock: () => jobNow,
    retentionDays: 3650,
    afterDays: 30,
    segmentBytes: 4096,
    ...overrides,
  });
}

function verifyJob() {
  return createArchiveVerifyJob({
    withTenant: createWithTenant(runtime.db),
    ...stores(),
    clock: () => jobNow,
  });
}

const runWrite = (retryCount = 0, id = crypto.randomUUID(), overrides = {}) =>
  runJob(runtime.db, writeJob(overrides), {
    id,
    name: ARCHIVE_WRITE_JOB,
    data: { tenantId: org.world.tenant.id },
    enqueuedAt: new Date(),
    retryCount,
  });

const runVerify = () =>
  runJob(runtime.db, verifyJob(), {
    id: crypto.randomUUID(),
    name: ARCHIVE_VERIFY_JOB,
    data: { tenantId: org.world.tenant.id },
    enqueuedAt: new Date(),
    retryCount: 0,
  });

const archiveRow = async () =>
  (await asTenant(runtime, org.world.tenant.id, (tx) => tx.select().from(tenantArchive)))[0];

async function platformEntries(action: string) {
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    const result = await admin.query<{
      action: string;
      outcome: string;
      metadata: Record<string, unknown>;
      operator_id: string | null;
      resource_id: string | null;
    }>(
      'select action, outcome, metadata, operator_id, resource_id from platform_audit_event where target_tenant_id = $1 and action = $2 order by occurred_at',
      [org.world.tenant.id, action],
    );
    return result.rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scratch = await mkdtemp(join(tmpdir(), 'archive-write-test-'));
  releaser = generateReleaserKeys();
  org = await createRetentionWorld(runtime, 'archive-write');
  const { world } = org;
  store = createFakeArchiveStore({ clock: () => jobNow });

  doctorA = await world.professional();
  doctorB = await world.professional();
  departed = await world.professional();
  const patientA = await world.patient([doctorA]);
  const patientB = await world.patient([doctorB]);
  const patientOrphan = await world.patient([departed]);
  await org.signedEntry(doctorA, patientA, entry(NOTE_A));
  await org.signedEntry(doctorB, patientB, entry(NOTE_B));
  await org.signedEntry(departed, patientOrphan, entry(NOTE_DEPARTED));
  const saved = await world.api.put(`/patients/${patientA}/anamnesis`, doctorA.session, {
    content: {
      allergies: [],
      medications: [],
      conditions: [],
      antecedents: ANAMNESIS_A,
      indicators: { pregnant: false, implantedDevice: false, anticoagulated: false },
    },
    expectedVersion: 0,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const left = await world.api.post(
    `/staff/${departed.session.user.membershipId}/deactivate`,
    world.owner,
  );
  expect(left.statusCode, left.body).toBe(200);

  expect((await org.cancel()).statusCode).toBe(200);
  await org.buildPackages();
}, 240_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await org.close();
  await runtime.close();
});

describe('before the export window is over', () => {
  it('does nothing: the owner and the professionals still have their packages to download', async () => {
    jobNow = new Date(Date.now() + 5 * DAY);

    const result = await runWrite();

    expect(result.status).toBe('completed');
    expect(await archiveRow()).toBeUndefined();
    expect(store.keys()).toEqual([]);
    const keys = await asTenant(runtime, org.world.tenant.id, (tx) => tx.select().from(archiveKey));
    expect(keys).toEqual([]);
  });

  it('is not due yet for the sweeper, and is due once the window has passed', async () => {
    const jobs = createRecordingJobClient();

    const early = await enqueueDueArchives(runtime.db, jobs, { afterDays: 30 });
    const ripe = await enqueueDueArchives(runtime.db, jobs, { afterDays: 0 });

    expect(early).toBe(0);
    expect(ripe).toBeGreaterThanOrEqual(1);
    expect(jobs.jobs.some((job) => job.payload.tenantId === org.world.tenant.id)).toBe(true);
    expect(jobs.jobs.every((job) => job.name === ARCHIVE_WRITE_JOB)).toBe(true);
  });
});

describe('after the window', () => {
  it('writes the archive: encrypted pieces and a manifest, the key made once, and the organization marked archived', async () => {
    jobNow = new Date(Date.now() + 31 * DAY);

    const result = await runWrite();
    const row = await archiveRow();

    expect(result.status).toBe('completed');
    expect(row).toMatchObject({ status: 'written', keyVersion: 1, verifiedAt: null });
    expect(row?.archivedAt?.getTime()).toBe(jobNow.getTime());
    expect(row?.retainUntil?.getTime()).toBe(jobNow.getTime() + 3650 * DAY);
    expect(row?.manifestKey).toMatch(
      new RegExp(
        `^tenants/${org.world.tenant.id}/${row?.archiveId ?? ''}/[0-9a-f-]+/manifest\\.json$`,
      ),
    );
    // Every object of the archive is in the store with the retention of the archive; the count includes the manifest.
    expect(store.keys()).toHaveLength(row?.objectsCount ?? -1);
    const head = await store.head(row?.manifestKey ?? '');
    expect(head.status === 'found' ? head.object.sha256 : '').toBe(row?.manifestSha256);
    const keys = await asTenant(runtime, org.world.tenant.id, (tx) => tx.select().from(archiveKey));
    expect(keys).toHaveLength(1);
  });

  it('stores nothing readable: no phrase of any record is in any stored byte, and the pieces are cut small', async () => {
    const row = await archiveRow();
    let multiPiece = false;

    for (const key of store.keys()) {
      if (key === row?.manifestKey) continue;
      const got = await store.get(key);
      expect(got.status).toBe('found');
      if (got.status !== 'found') continue;
      const text = Buffer.from(got.body).toString('latin1');
      for (const phrase of [NOTE_A, NOTE_B, NOTE_DEPARTED, ANAMNESIS_A, 'Paciente']) {
        expect(text, key).not.toContain(phrase);
      }
      if (key.endsWith('/000002.enc')) multiPiece = true;
    }
    expect(multiPiece).toBe(true);
  });

  it('writes the manifest in plain: names, sizes and checksums of every piece, and no content', async () => {
    const row = await archiveRow();
    const got = await store.get(row?.manifestKey ?? '');
    const manifest = parseManifest(got.status === 'found' ? got.body : new Uint8Array());

    expect(manifest.tenantId).toBe(org.world.tenant.id);
    expect(manifest.keyVersion).toBe(1);
    expect(manifest.parts.map((part) => part.part)).toEqual(
      expect.arrayContaining([
        'administrative',
        `clinical-${doctorA.professionalId}`,
        `clinical-${doctorB.professionalId}`,
        // The professional who left has a part of their own: their patients' records are in custody.
        `clinical-${departed.professionalId}`,
      ]),
    );
    for (const object of manifest.parts.flatMap((part) => part.objects)) {
      const stored = await store.get(object.name);
      expect(stored.status === 'found' ? sha256(stored.body) : '').toBe(object.sealedSha256);
    }
    expect(JSON.stringify(manifest)).not.toContain(NOTE_A);
    expect(sha256(got.status === 'found' ? got.body : new Uint8Array())).toBe(row?.manifestSha256);
  });

  it('keeps the hot rows: nothing of the organization was removed', async () => {
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      const counts = await admin.query<{ notes: number; patients: number }>(
        `select (select count(*)::int from clinical_note where tenant_id = $1) as notes,
                (select count(*)::int from patient where tenant_id = $1) as patients`,
        [org.world.tenant.id],
      );
      expect(counts.rows[0]).toEqual({ notes: 3, patients: 3 });
    } finally {
      await admin.end();
    }
    const [state] = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant),
    );
    expect(state?.status).toBe('cancelled');
  });

  it('writes the archive entry in the platform trail, with counts and no content, and no operator', async () => {
    const written = await platformEntries('archive.written');

    expect(written).toHaveLength(1);
    expect(written[0]?.operator_id).toBeNull();
    expect(written[0]?.metadata).toMatchObject({ keyVersion: 1 });
    expect(Number(written[0]?.metadata['objects'])).toBeGreaterThan(4);
    expect(JSON.stringify(written)).not.toContain(NOTE_A);
  });

  it('writes the archive once: a second run does nothing and the store is the same', async () => {
    const before = store.keys();

    const again = await runWrite();

    expect(again.status).toBe('completed');
    expect(store.keys()).toEqual(before);
    expect(await platformEntries('archive.written')).toHaveLength(1);
  });

  it('is not due any more for the sweeper', async () => {
    const jobs = createRecordingJobClient();

    await enqueueDueArchives(runtime.db, jobs, { afterDays: 0 });

    expect(jobs.jobs.some((job) => job.payload.tenantId === org.world.tenant.id)).toBe(false);
  });
});

describe('who can read the archive', () => {
  it("lets the releaser put the packages back together, byte for byte, the leaver's records included", async () => {
    const row = await archiveRow();
    const got = await store.get(row?.manifestKey ?? '');
    const manifest = parseManifest(got.status === 'found' ? got.body : new Uint8Array());
    const withTenant = createWithTenant(runtime.db);
    const releaserKeys = createArchiveKeyReleaser({ kek: releaser.kek });
    const privateKey = await withTenant(
      { tenantId: org.world.tenant.id, userId: org.operator.id },
      (tx) => releaserKeys.privateKey(tx, org.world.tenant.id, manifest.keyVersion),
    );

    const restored = await restoreParts({ store, manifest, privateKey, outDir: scratch });
    const zips = new Map<string, Map<string, Buffer>>();
    for (const part of restored) zips.set(part.part, readZip(await readFile(part.path)));

    expect(restored.map((part) => part.part)).toEqual(manifest.parts.map((part) => part.part));
    expect(allTextOf(zips.get('administrative') ?? new Map())).toContain('Clinica');
    expect(allTextOf(zips.get('administrative') ?? new Map())).not.toContain(NOTE_A);
    expect(allTextOf(zips.get(`clinical-${doctorA.professionalId}`) ?? new Map())).toContain(
      NOTE_A,
    );
    expect(allTextOf(zips.get(`clinical-${doctorA.professionalId}`) ?? new Map())).toContain(
      ANAMNESIS_A,
    );
    expect(allTextOf(zips.get(`clinical-${doctorB.professionalId}`) ?? new Map())).toContain(
      NOTE_B,
    );
    expect(allTextOf(zips.get(`clinical-${doctorB.professionalId}`) ?? new Map())).not.toContain(
      NOTE_A,
    );
    // The professional who left is no one's package, but the archive holds what they wrote.
    expect(allTextOf(zips.get(`clinical-${departed.professionalId}`) ?? new Map())).toContain(
      NOTE_DEPARTED,
    );
  });

  it('keeps the private key sealed: the row opens with the key of the releaser and with nothing a writer holds', async () => {
    const [key] = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx.select().from(archiveKey),
    );
    const context = { tenantId: org.world.tenant.id, version: 1 };

    expect(() =>
      unwrapPrivateKey(key?.wrappedPrivateKey ?? Buffer.alloc(0), releaser.kek, context),
    ).not.toThrow();
    // Everything a writer is given: the public key of the releaser, the public key of the organization.
    expect(() =>
      unwrapPrivateKey(key?.wrappedPrivateKey ?? Buffer.alloc(0), releaser.publicKey, context),
    ).toThrow();
    expect(() =>
      unwrapPrivateKey(
        key?.wrappedPrivateKey ?? Buffer.alloc(0),
        generateReleaserKeys().kek,
        context,
      ),
    ).toThrow();
    // And an object sealed to that public key does not open with it.
    const some = store.keys().find((name) => name.endsWith('/000001.enc')) ?? '';
    const sealed = await store.get(some);
    expect(() =>
      openObject(
        Buffer.from(sealed.status === 'found' ? sealed.body : []),
        key?.publicKey ?? Buffer.alloc(0),
        {
          tenantId: org.world.tenant.id,
          name: some,
          keyVersion: 1,
        },
      ),
    ).toThrow();
  });

  it("refuses the private key of a version that does not exist, and of another organization's row", async () => {
    const releaserKeys = createArchiveKeyReleaser({ kek: releaser.kek });
    const withTenant = createWithTenant(runtime.db);

    await expect(
      withTenant({ tenantId: org.world.tenant.id, userId: org.operator.id }, (tx) =>
        releaserKeys.privateKey(tx, org.world.tenant.id, 2),
      ),
    ).rejects.toThrow(/no archive key/);
    await expect(
      withTenant({ tenantId: org.world.tenant.id, userId: org.operator.id }, (tx) =>
        releaserKeys.privateKey(tx, '0190a000-0000-7000-8000-00000000dead', 1),
      ),
    ).rejects.toThrow();
  });
});

describe('the verification', () => {
  it('is due while the archive was never verified', async () => {
    const jobs = createRecordingJobClient();

    await enqueueDueVerifications(runtime.db, jobs, { everyDays: 7 });

    expect(jobs.jobs.some((job) => job.payload.tenantId === org.world.tenant.id)).toBe(true);
    expect(jobs.jobs.every((job) => job.name === ARCHIVE_VERIFY_JOB)).toBe(true);
  });

  it('finds an intact archive intact, records it and writes the entry in the platform trail', async () => {
    jobNow = new Date(Date.now() + 32 * DAY);

    const result = await runVerify();
    const row = await archiveRow();

    expect(result.status).toBe('completed');
    expect(row).toMatchObject({ verifyStatus: 'ok', verifyProblems: 0 });
    expect(row?.verifiedAt?.getTime()).toBe(jobNow.getTime());
    const entries = await platformEntries('archive.verified');
    expect(entries.at(-1)?.metadata).toMatchObject({ status: 'ok', problems: 0 });
  });

  it('is not due again right after it was verified', async () => {
    const jobs = createRecordingJobClient();

    // Verified just now (the job's clock is ahead of the database's): not due for a week.
    await enqueueDueVerifications(runtime.db, jobs, { everyDays: 7 });

    expect(jobs.jobs.some((job) => job.payload.tenantId === org.world.tenant.id)).toBe(false);
  });

  it('detects a corrupted object', async () => {
    const some = store.keys().find((name) => name.endsWith('/000001.enc')) ?? '';
    store.damage(some);

    await runVerify();

    expect(await archiveRow()).toMatchObject({ verifyStatus: 'corrupted', verifyProblems: 1 });
    expect((await platformEntries('archive.verified')).at(-1)?.metadata).toMatchObject({
      status: 'corrupted',
    });
  });

  it('detects a version added behind the store, and an object that went missing (the worse finding wins)', async () => {
    const pieces = store.keys().filter((name) => name.endsWith('.enc'));
    const shadowed = pieces[1] ?? '';
    const lost = pieces[2] ?? '';
    store.shadow(shadowed);
    await runVerify();
    const afterShadow = await archiveRow();
    store.lose(lost);

    await runVerify();
    const afterLoss = await archiveRow();

    // Still damaged from the previous test, plus the shadow: corrupted outranks overwritten.
    expect(afterShadow).toMatchObject({ verifyStatus: 'corrupted', verifyProblems: 2 });
    expect(afterLoss).toMatchObject({ verifyStatus: 'missing', verifyProblems: 3 });
  });

  it('detects a manifest that is not the one that was recorded', async () => {
    const row = await archiveRow();
    store.damage(row?.manifestKey ?? '');

    await runVerify();

    expect(await archiveRow()).toMatchObject({ verifyStatus: 'corrupted' });
  });
});

describe('a store that fails', () => {
  it('leaves the attempt to the queue, then writes a whole archive in a folder of its own', async () => {
    const world = await createRetentionWorld(runtime, 'archive-write-flaky', {
      storage: org.storage,
    });
    try {
      const doctor = await world.world.professional();
      const patient = await world.world.patient([doctor]);
      await world.signedEntry(
        doctor,
        patient,
        entry('Primera consulta del consultorio con fallas'),
      );
      expect((await world.cancel()).statusCode).toBe(200);
      await world.buildPackages();

      const inner = createFakeArchiveStore({ clock: () => jobNow });
      let puts = 0;
      let healthy = false;
      const flaky: ArchiveStore = {
        ...inner,
        put: (key, body, options, signal) => {
          puts += 1;
          if (!healthy && puts > 1) {
            return Promise.resolve({ status: 'retryable', message: 'down', outcomeUnknown: false });
          }
          return inner.put(key, body, options, signal);
        },
        head: (key, signal) => inner.head(key, signal),
        get: (key, signal) => inner.get(key, signal),
        list: (prefix, signal) => inner.list(prefix, signal),
        remove: (key, signal) => inner.remove(key, signal),
      };
      const withTenant = createWithTenant(runtime.db);
      const job = () =>
        createArchiveWriteJob({
          exports: world.exports,
          withTenant,
          storage: world.storage,
          store: flaky,
          keys: createArchiveKeyWriter({ withTenant, releaserPublicKey: releaser.publicKey }),
          clock: () => jobNow,
          retentionDays: 3650,
          afterDays: 30,
          segmentBytes: 4096,
        });
      const run = (retryCount: number) =>
        runJob(runtime.db, job(), {
          id: crypto.randomUUID(),
          name: ARCHIVE_WRITE_JOB,
          data: { tenantId: world.world.tenant.id },
          enqueuedAt: new Date(),
          retryCount,
        });
      jobNow = new Date(Date.now() + 31 * DAY);

      await expect(run(0)).rejects.toThrow(/could not take the object/);
      const pending = (
        await asTenant(runtime, world.world.tenant.id, (tx) => tx.select().from(tenantArchive))
      )[0];
      const orphans = inner.keys();
      healthy = true;
      const result = await run(1);
      const done = (
        await asTenant(runtime, world.world.tenant.id, (tx) => tx.select().from(tenantArchive))
      )[0];

      expect(pending).toMatchObject({ status: 'pending', manifestKey: null });
      expect(result.status).toBe('completed');
      expect(done).toMatchObject({ status: 'written', archiveId: pending?.archiveId });
      const manifestBytes = await inner.get(done?.manifestKey ?? '');
      const manifest = parseManifest(
        manifestBytes.status === 'found' ? manifestBytes.body : new Uint8Array(),
      );
      const named = manifest.parts.flatMap((part) => part.objects.map((object) => object.name));
      // Everything the manifest names is in the new attempt's folder; the first attempt's pieces are orphans.
      expect(named.every((name) => name.includes(`/${manifest.attemptId}/`))).toBe(true);
      expect(orphans.length).toBeGreaterThan(0);
      expect(orphans.every((name) => !named.includes(name))).toBe(true);
    } finally {
      await world.close();
    }
  });

  it('gives up with a code on the last delivery and is not asked again', async () => {
    const world = await createRetentionWorld(runtime, 'archive-write-down', {
      storage: org.storage,
    });
    try {
      await world.world.professional();
      expect((await world.cancel()).statusCode).toBe(200);
      await world.buildPackages();
      const down = createFakeArchiveStore({ clock: () => jobNow });
      down.setMode('down');
      const withTenant = createWithTenant(runtime.db);
      jobNow = new Date(Date.now() + 31 * DAY);

      const result = await runJob(
        runtime.db,
        createArchiveWriteJob({
          exports: world.exports,
          withTenant,
          storage: world.storage,
          store: down,
          keys: createArchiveKeyWriter({ withTenant, releaserPublicKey: releaser.publicKey }),
          clock: () => jobNow,
          retentionDays: 3650,
          afterDays: 30,
        }),
        {
          id: crypto.randomUUID(),
          name: ARCHIVE_WRITE_JOB,
          data: { tenantId: world.world.tenant.id },
          enqueuedAt: new Date(),
          retryCount: 2,
        },
      );
      const [row] = await asTenant(runtime, world.world.tenant.id, (tx) =>
        tx.select().from(tenantArchive),
      );
      const jobs = createRecordingJobClient();
      await enqueueDueArchives(runtime.db, jobs, { afterDays: 0 });

      expect(result.status).toBe('completed');
      expect(row).toMatchObject({ status: 'failed', failureCode: 'write_failed' });
      expect(jobs.jobs.some((job) => job.payload.tenantId === world.world.tenant.id)).toBe(false);
    } finally {
      await world.close();
    }
  });
});

describe('the keys of the archive', () => {
  it('makes one key per organization however many writers ask at once', async () => {
    const world = await createRetentionWorld(runtime, 'archive-write-keys', {
      storage: org.storage,
    });
    try {
      const withTenant = createWithTenant(runtime.db);
      const writer = createArchiveKeyWriter({ withTenant, releaserPublicKey: releaser.publicKey });
      const context = { tenantId: world.world.tenant.id, userId: org.operator.id };

      const found = await Promise.all([
        writer.current(context),
        writer.current(context),
        writer.current(context),
      ]);
      const rows = await asTenant(runtime, world.world.tenant.id, (tx) =>
        tx.select().from(archiveKey).orderBy(asc(archiveKey.version)),
      );

      expect(rows).toHaveLength(1);
      expect(new Set(found.map((key) => key.publicKey.toString('hex'))).size).toBe(1);
      expect(found[0].publicKey.equals(rows[0]?.publicKey ?? Buffer.alloc(0))).toBe(true);
    } finally {
      await world.close();
    }
  });

  it('cannot be changed or removed by the runtime role', async () => {
    const attempt = (statement: ReturnType<typeof sql>) =>
      asTenant(runtime, org.world.tenant.id, (tx) => tx.execute(statement)).then(
        () => 'allowed',
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
      );

    expect(await attempt(sql`update archive_key set version = version + 10`)).toBe('42501');
    expect(await attempt(sql`delete from archive_key`)).toBe('42501');
    expect(await attempt(sql`delete from tenant_archive`)).toBe('42501');
    expect(await attempt(sql`update tenant_archive set archive_id = app.uuid_v7()`)).toBe('42501');
  });
});
