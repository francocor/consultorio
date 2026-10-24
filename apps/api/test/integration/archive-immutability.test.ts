import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectLockConfigurationCommand,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLegalErasure } from '../../src/adapters/archive-local/erasure.js';
import { createLocalArchiveStore } from '../../src/adapters/archive-local/index.js';
import { createLegalEraseDatabase } from '../../src/modules/tenancy/archive/legal-erase-database.js';
import { legalErase } from '../../src/modules/tenancy/archive/legal-erase.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { startArchiveMinio, type ArchiveMinio } from '../support/archive-minio.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The immutability of the retention archive against the real bucket (tenancy, "Retention archive after
 * cancellation": "Records in the archive MUST NOT be modified or hard-deleted during that period",
 * with a single exception, the legal erasure). Slow: it needs MinIO, the same image the development
 * environment runs, with the bucket created as `infra/docker-compose.yml` creates it.
 *
 * What is proven is what each identity CAN DO to an object that is inside its retention:
 * - the writer of the API, the worker and the releaser cannot delete it, cannot delete a version of it,
 *   cannot shorten its retention and cannot change the lock of the bucket;
 * - not even the root user of the service can delete it without saying that it bypasses governance;
 * - a writer that skips the `If-None-Match` of the adapter can add a version under the key, but the
 *   archive keeps serving the original, and the object says that something else is there;
 * - only the `legal-erasure` identity removes it, version by version, and it needs the reference.
 */
let minio: ArchiveMinio;
let writer: S3Client;
let erasure: S3Client;

const clientFor = (credentials: S3ClientConfig['credentials']) =>
  new S3Client({
    region: 'us-east-1',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials,
    maxAttempts: 1,
  });

beforeAll(async () => {
  minio = await startArchiveMinio();
  writer = clientFor(minio.writer);
  erasure = clientFor(minio.legalErasure);
}, 180_000);

afterAll(async () => {
  writer.destroy();
  erasure.destroy();
  await minio.stop();
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const inAYear = () => new Date(Date.now() + 365 * 24 * 3600 * 1000);

function adapter(credentials = minio.writer) {
  return createLocalArchiveStore({
    bucket: minio.bucket,
    region: minio.region,
    endpoint: minio.endpoint,
    credentials,
  });
}

async function archived(key: string, text: string) {
  const store = adapter();
  try {
    const result = await store.put(key, new TextEncoder().encode(text), {
      sha256: sha256(text),
      retainUntil: inAYear(),
    });
    expect(result.status).toBe('stored');
  } finally {
    store.close();
  }
}

/** The error name an attempt ends with, or "allowed". */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return (error as Error).name;
  }
}

async function versionsOf(client: S3Client, key: string) {
  const listed = await client.send(
    new ListObjectVersionsCommand({ Bucket: minio.bucket, Prefix: key }),
  );
  return (listed.Versions ?? []).filter((version) => version.Key === key);
}

describe('what the writer cannot do to an archived object', () => {
  it('cannot delete it, nor a version of it', async () => {
    const key = 'immutability/delete-by-writer';
    await archived(key, 'records of a cancelled organization');
    const [version] = await versionsOf(writer, key);

    const plain = await outcome(() =>
      writer.send(new DeleteObjectCommand({ Bucket: minio.bucket, Key: key })),
    );
    const byVersion = await outcome(() =>
      writer.send(
        new DeleteObjectCommand({ Bucket: minio.bucket, Key: key, VersionId: version?.VersionId }),
      ),
    );
    const bypassing = await outcome(() =>
      writer.send(
        new DeleteObjectCommand({
          Bucket: minio.bucket,
          Key: key,
          VersionId: version?.VersionId,
          BypassGovernanceRetention: true,
        }),
      ),
    );

    expect([plain, byVersion, bypassing]).toEqual(['AccessDenied', 'AccessDenied', 'AccessDenied']);
    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('cannot shorten the retention of the object or of the bucket', async () => {
    const objectName = 'immutability/shorten';
    await archived(objectName, 'kept');

    const object = await outcome(() =>
      writer.send(
        new PutObjectRetentionCommand({
          Bucket: minio.bucket,
          Key: objectName,
          Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 1000) },
        }),
      ),
    );
    const bucket = await outcome(() =>
      writer.send(
        new PutObjectLockConfigurationCommand({
          Bucket: minio.bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
          },
        }),
      ),
    );

    expect(object).not.toBe('allowed');
    expect(bucket).toBe('AccessDenied');
    const store = adapter();
    const head = await store.head(objectName);
    store.close();
    expect(head.status === 'found' ? Date.parse(head.object.retainUntil) : 0).toBeGreaterThan(
      Date.now() + 300 * 24 * 3600 * 1000,
    );
  });

  it('cannot replace the object through the adapter: the same key with other bytes is refused by the service', async () => {
    const key = 'immutability/overwrite-by-adapter';
    await archived(key, 'original');
    const store = adapter();

    const other = await store.put(key, new TextEncoder().encode('forged'), {
      sha256: sha256('forged'),
      retainUntil: inAYear(),
    });
    const got = await store.get(key);
    store.close();

    expect(other.status).toBe('locked');
    expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('original');
    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('can add a version behind the adapter, but the archive keeps serving the original and says something else is there', async () => {
    const key = 'immutability/overwrite-behind-the-adapter';
    await archived(key, 'original');

    // What a leaked writer credential could do: PUT without the header the adapter sends.
    const put = await writer.send(
      new PutObjectCommand({
        Bucket: minio.bucket,
        Key: key,
        Body: Buffer.from('forged'),
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: inAYear(),
        Metadata: { sha256: sha256('forged') },
      }),
    );
    const store = adapter();
    const head = await store.head(key);
    const got = await store.get(key);
    const listed = await store.list('immutability/overwrite-behind-the-adapter');
    store.close();

    expect(put.VersionId).toBeDefined();
    expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('original');
    expect(head.status === 'found' ? head.object.sha256 : '').toBe(sha256('original'));
    expect(head.status === 'found' ? head.object.versions : 0).toBe(2);
    expect(listed.status === 'ok' ? listed.objects.map((entry) => entry.versions) : []).toEqual([
      2,
    ]);
    // The service still holds the original version, locked, byte for byte.
    const versions = await versionsOf(writer, key);
    const original = versions.at(-1);
    const read = await writer.send(
      new GetObjectCommand({ Bucket: minio.bucket, Key: key, VersionId: original?.VersionId }),
    );
    expect(await read.Body?.transformToString()).toBe('original');
  });
});

describe('what nobody can do inside the retention', () => {
  it('lets not even the root user delete a version without saying it bypasses governance', async () => {
    const key = 'immutability/root';
    await archived(key, 'kept');
    const root = clientFor(minio.root);
    try {
      const [version] = await versionsOf(root, key);

      const plain = await outcome(() =>
        root.send(
          new DeleteObjectCommand({
            Bucket: minio.bucket,
            Key: key,
            VersionId: version?.VersionId,
          }),
        ),
      );

      expect(plain).not.toBe('allowed');
      expect(await versionsOf(root, key)).toHaveLength(1);
    } finally {
      root.destroy();
    }
  });
});

describe('the legal erasure', () => {
  it('is refused to a credential that is not the legal-erasure one', async () => {
    const key = 'immutability/erase-by-writer';
    await archived(key, 'kept');
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.writer,
    });

    await expect(eraser.erase(key, { reference: 'Oficio 123/2031' })).rejects.toMatchObject({
      name: 'AccessDenied',
    });
    eraser.close();

    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('removes every version of the object for the privileged identity, and needs the reference', async () => {
    const key = 'immutability/erase-by-privileged';
    await archived(key, 'to be erased by order');
    await writer.send(
      new PutObjectCommand({
        Bucket: minio.bucket,
        Key: key,
        Body: Buffer.from('second version'),
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: inAYear(),
      }),
    );
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.legalErasure,
    });

    await expect(eraser.erase(key, { reference: '   ' })).rejects.toThrow(/legal reference/);
    expect(await versionsOf(erasure, key)).toHaveLength(2);

    const erased = await eraser.erase(key, { reference: 'Oficio 123/2031, Juzgado Civil 4' });
    const again = await eraser.erase(key, { reference: 'Oficio 123/2031, Juzgado Civil 4' });
    eraser.close();

    expect(erased).toEqual({ status: 'erased', versions: 2 });
    expect(again).toEqual({ status: 'unknown' });
    expect(await versionsOf(erasure, key)).toHaveLength(0);
    const store = adapter();
    expect(await store.head(key)).toEqual({ status: 'unknown' });
    store.close();
  });
});

describe('the legal erasure procedure', () => {
  let runtime: DbHandle;
  let operators: OperatorHarness;

  beforeAll(() => {
    runtime = createRuntimeDb(inject('runtimeUrl'));
    operators = createOperatorHarness();
  });
  afterAll(async () => {
    await operators.close();
    await runtime.close();
  });

  it('erases the archive of one organization for the privileged identity, writes the legal reference in the platform trail, and leaves another organization alone', async () => {
    const organization = await createTestTenant(runtime, { slug: 'immutability-erase' });
    const other = await createTestTenant(runtime, { slug: 'immutability-keep' });
    const mine = `tenants/${organization.id}/archive-1/attempt-1/administrative/000001.enc`;
    const theirs = `tenants/${other.id}/archive-1/attempt-1/administrative/000001.enc`;
    await archived(mine, 'records to erase by order');
    await archived(theirs, 'records to keep');
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.legalErasure,
    });
    const reference = 'Oficio 77/2031, Juzgado Civil 9, expediente 5120/2030';
    const withTenant = createWithTenant(operators.db.db);
    const runner = await operators.addOperator();
    const approver = await operators.addOperator();
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      // The archive row of the organization, so the erasure has a state to record.
      await admin.query(
        `insert into tenant_archive (tenant_id, archive_id, key_version, status, manifest_key, manifest_sha256, objects_count, bytes_total, retain_until, archived_at)
         values ($1, app.uuid_v7(), 1, 'written', $2, $3, 1, 10, now() + interval '3650 days', now())`,
        [organization.id, mine, 'b'.repeat(64)],
      );

      const result = await legalErase(
        {
          eraser,
          ...createLegalEraseDatabase({
            withTenant,
            tenantId: organization.id,
            operatorId: runner.id,
          }),
        },
        {
          tenantId: organization.id,
          reference,
          operatorId: runner.id,
          approverId: approver.id,
        },
      );
      eraser.close();

      expect(result).toEqual({ objects: 1, versions: 1 });
      expect(await versionsOf(erasure, mine)).toHaveLength(0);
      expect(await versionsOf(erasure, theirs)).toHaveLength(1);
      // The intent is written before the erasure and the outcome after it, by the named operator, with
      // the approver in the entry: two entries, append-only.
      const trail = await admin.query<{
        reason: string;
        operator_id: string;
        metadata: Record<string, unknown>;
      }>(
        "select reason, operator_id, metadata from platform_audit_event where action = 'archive.erased' and target_tenant_id = $1 order by occurred_at, id",
        [organization.id],
      );
      const prefix = `tenants/${organization.id}/`;
      expect(trail.rows).toEqual([
        {
          reason: reference,
          operator_id: runner.id,
          metadata: {
            phase: 'intent',
            objects: 1,
            versions: 0,
            complete: false,
            namedSecondOperator: approver.id,
            prefix,
          },
        },
        {
          reason: reference,
          operator_id: runner.id,
          metadata: {
            phase: 'done',
            objects: 1,
            versions: 1,
            complete: true,
            namedSecondOperator: approver.id,
            prefix,
          },
        },
      ]);
      // And the database remembers: the archive is erased, so verification skips it and no release can
      // be recorded for it.
      const state = await admin.query<{ erased_prefixes: string[]; erased_at: Date | null }>(
        'select erased_prefixes, erased_at from tenant_archive where tenant_id = $1',
        [organization.id],
      );
      expect(state.rows[0]?.erased_prefixes).toEqual([prefix]);
      expect(state.rows[0]?.erased_at).not.toBeNull();
      const due = await admin.query<{ tenant_id: string }>(
        'select * from app.archive_verify_due(0, 500) as tenant_id',
      );
      expect(JSON.stringify(due.rows)).not.toContain(organization.id);
      const written = await admin.query<{ written: boolean }>(
        'select app.archive_is_written($1) as written',
        [organization.id],
      );
      expect(written.rows[0]?.written).toBe(false);
    } finally {
      await admin.end();
    }
  });

  it('refuses an empty listing when no erasure was started, marks nothing and writes nothing; after an intent it audits a rerun and then marks (JD-S6 R3-1)', async () => {
    const organization = await createTestTenant(runtime, { slug: 'immutability-empty' });
    const name = `tenants/${organization.id}/archive-1/attempt-1/administrative/000001.enc`;
    const reference = 'Oficio 79/2031, Juzgado Civil 9, expediente 5121/2030';
    const runner = await operators.addOperator();
    const approver = await operators.addOperator();
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.legalErasure,
    });
    const run = () =>
      legalErase(
        {
          eraser,
          ...createLegalEraseDatabase({
            withTenant: createWithTenant(operators.db.db),
            tenantId: organization.id,
            operatorId: runner.id,
          }),
        },
        { tenantId: organization.id, reference, operatorId: runner.id, approverId: approver.id },
      );
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      await admin.query(
        `insert into tenant_archive (tenant_id, archive_id, key_version, status, manifest_key, manifest_sha256, objects_count, bytes_total, retain_until, archived_at)
         values ($1, app.uuid_v7(), 1, 'written', $2, $3, 1, 10, now() + interval '3650 days', now())`,
        [organization.id, name, 'c'.repeat(64)],
      );
      const state = async () =>
        (
          await admin.query<{ erased_at: Date | null; entries: string }>(
            `select a.erased_at,
                    (select count(*) from platform_audit_event e
                      where e.action = 'archive.erased' and e.target_tenant_id = a.tenant_id) as entries
               from tenant_archive a where a.tenant_id = $1`,
            [organization.id],
          )
        ).rows[0];

      // Nothing under the prefix and no intent in the trail: it could be the wrong bucket.
      await expect(run()).rejects.toThrow(/confirm the bucket/i);
      expect(await state()).toMatchObject({ erased_at: null, entries: '0' });

      // An erasure that is started and completed leaves the intent in the trail; if the marker is lost
      // and the command is run again, the empty folder is audited as a rerun and then marked.
      await archived(name, 'records to erase by order');
      await run();
      await admin.query(
        "update tenant_archive set erased_at = null, erased_prefixes = '{}' where tenant_id = $1",
        [organization.id],
      );
      expect(await run()).toEqual({ objects: 0, versions: 0 });
      eraser.close();

      expect((await state())?.erased_at).not.toBeNull();
      const phases = await admin.query<{ phase: string; operator_id: string; reason: string }>(
        "select metadata ->> 'phase' as phase, operator_id, reason from platform_audit_event where action = 'archive.erased' and target_tenant_id = $1 order by occurred_at, id",
        [organization.id],
      );
      expect(phases.rows).toEqual([
        { phase: 'intent', operator_id: runner.id, reason: reference },
        { phase: 'done', operator_id: runner.id, reason: reference },
        { phase: 'rerun', operator_id: runner.id, reason: reference },
      ]);
    } finally {
      await admin.end();
    }
  });

  it('refuses a named operator who is not an active operator of the console, before anything is erased', async () => {
    const organization = await createTestTenant(runtime, { slug: 'immutability-stranger' });
    const name = `tenants/${organization.id}/archive-1/attempt-1/administrative/000001.enc`;
    await archived(name, 'kept because nobody real ordered it');
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.legalErasure,
    });
    const runner = await operators.addOperator();
    const stranger = '0190a000-0000-7000-8000-00000000dead';

    await expect(
      legalErase(
        {
          eraser,
          ...createLegalEraseDatabase({
            withTenant: createWithTenant(operators.db.db),
            tenantId: organization.id,
            operatorId: runner.id,
          }),
        },
        {
          tenantId: organization.id,
          reference: 'Oficio 78/2031, Juzgado Civil 9',
          operatorId: runner.id,
          approverId: stranger,
        },
      ),
    ).rejects.toThrow(/active operators/);
    eraser.close();

    expect(await versionsOf(erasure, name)).toHaveLength(1);
  });

  it('is refused to the writer of the application: its credential cannot erase, nothing is marked erased, and the trail says it did not complete', async () => {
    const organization = await createTestTenant(runtime, { slug: 'immutability-refused' });
    const name = `tenants/${organization.id}/archive-1/attempt-1/administrative/000001.enc`;
    await archived(name, 'kept');
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.writer,
    });
    const phases: string[] = [];
    let marked = 0;
    const [runner, approver] = [await operators.addOperator(), await operators.addOperator()];

    await expect(
      legalErase(
        {
          eraser,
          verifyOperators: () => Promise.resolve(),
          hasIntent: () => Promise.resolve(false),
          markErased: () => {
            marked += 1;
            return Promise.resolve();
          },
          audit: (entry) => {
            phases.push(entry.phase);
            return Promise.resolve();
          },
        },
        {
          tenantId: organization.id,
          reference: 'Oficio 88/2031',
          operatorId: runner.id,
          approverId: approver.id,
        },
      ),
    ).rejects.toMatchObject({ name: 'AccessDenied' });
    eraser.close();

    expect(phases).toEqual(['intent', 'incomplete']);
    expect(marked).toBe(0);
    expect(await versionsOf(writer, name)).toHaveLength(1);
  });
});
