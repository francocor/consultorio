import type { DownloadLinkResponse, ExportPackageResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { exportPackage } from '../../src/db/schema/export-package.js';
import { removeSpentExports } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createRetentionWorld, type RetentionWorld } from '../support/retention-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * The plain packages of the cancellation export leave the bucket once the archive that replaces them is
 * written and verified, and the download window is over (JD-S6 R1-A-W7). Before that they are kept:
 * the owner and the professionals still download them.
 */
let runtime: DbHandle;
let org: RetentionWorld;
let admin: pg.Client;

const AFTER_DAYS = 30;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  org = await createRetentionWorld(runtime, 'export-cleanup');
  const doctor = await org.world.professional();
  const patient = await org.world.patient([doctor]);
  await org.signedEntry(doctor, patient, { reasonForConsultation: 'Control de rutina' });
  expect((await org.cancel()).statusCode).toBe(200);
  await org.buildPackages();
}, 300_000);

afterAll(async () => {
  await admin.end();
  await org.close();
  await runtime.close();
});

const packages = () =>
  asTenant(runtime, org.world.tenant.id, (tx) => tx.select().from(exportPackage));

const clean = () =>
  removeSpentExports({
    db: runtime.db,
    withTenant: createWithTenant(runtime.db),
    storage: org.storage,
    clock: () => new Date(),
    afterDays: AFTER_DAYS,
  });

const stored = async () => {
  const rows = await packages();
  let present = 0;
  for (const row of rows) {
    if (row.objectKey && (await org.storage.head(org.world.tenant.id, row.objectKey)) !== null) {
      present += 1;
    }
  }
  return present;
};

const archive = (verifyStatus: string | null, verifiedAt: string | null) =>
  admin.query(
    `insert into tenant_archive (tenant_id, archive_id, key_version, status, manifest_key, manifest_sha256,
                                 objects_count, bytes_total, retain_until, archived_at, verified_at, verify_status)
     values ($1, app.uuid_v7(), 1, 'written', 'tenants/x/manifest.json', $2, 3, 300,
             now() + interval '3650 days', now(), $3, $4)
     on conflict (tenant_id) do update set verified_at = excluded.verified_at, verify_status = excluded.verify_status`,
    [org.world.tenant.id, 'd'.repeat(64), verifiedAt, verifyStatus],
  );

describe('the plain export of a cancelled organization', () => {
  it('is built, and there is at least one package in the bucket', async () => {
    expect((await packages()).length).toBeGreaterThanOrEqual(1);
    expect(await stored()).toBe((await packages()).length);
  });

  it('is kept while there is no archive, and while the archive was not verified', async () => {
    await clean();
    expect(await stored()).toBe((await packages()).length);

    await archive(null, null);
    await admin.query(
      `update export_package set created_at = now() - interval '60 days' where tenant_id = $1`,
      [org.world.tenant.id],
    );
    await clean();

    expect(await stored()).toBe((await packages()).length);
    expect((await packages()).every((row) => row.objectRemovedAt === null)).toBe(true);
  });

  it('is kept while the download window is not over, even if the archive is verified', async () => {
    await archive('ok', new Date().toISOString());
    await admin.query(
      `update export_package set created_at = now() - interval '2 days' where tenant_id = $1`,
      [org.world.tenant.id],
    );

    await clean();

    expect(await stored()).toBe((await packages()).length);
  });

  it('is kept when the verification found a problem: the plain copy may be the only good one', async () => {
    await archive('corrupted', new Date().toISOString());
    await admin.query(
      `update export_package set created_at = now() - interval '60 days' where tenant_id = $1`,
      [org.world.tenant.id],
    );

    await clean();

    expect(await stored()).toBe((await packages()).length);
  });

  it('is due too when the archive was erased whole by a legal order, verified or not (JD-S6 R2-3)', async () => {
    const due = async () =>
      (
        await admin.query<{ tenant: string }>(
          'select app.export_cleanup_due($1, 500)::text as tenant',
          [AFTER_DAYS],
        )
      ).rows.map((row) => row.tenant);
    await archive('corrupted', new Date().toISOString());

    const whileCorrupted = await due();
    await admin.query(
      `update tenant_archive set erased_at = now(), erased_prefixes = array[$2::text] where tenant_id = $1`,
      [org.world.tenant.id, `tenants/${org.world.tenant.id}/`],
    );
    const whenErased = await due();
    // Back to a written, unerased archive for the tests that follow.
    await admin.query(
      `update tenant_archive set erased_at = null, erased_prefixes = '{}' where tenant_id = $1`,
      [org.world.tenant.id],
    );

    expect(whileCorrupted).not.toContain(org.world.tenant.id);
    expect(whenErased).toContain(org.world.tenant.id);
  });

  it('is removed when the window is over and the archive was verified: the object goes, the row says so, the trail records it', async () => {
    await archive('ok', new Date().toISOString());
    const count = (await packages()).length;

    const removed = await clean();

    // The database is shared with the other files: another organization may be due as well.
    expect(removed).toBeGreaterThanOrEqual(count);
    expect(await stored()).toBe(0);
    const rows = await packages();
    expect(rows.every((row) => row.objectRemovedAt !== null)).toBe(true);
    const trail = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx
        .select({ action: auditEvent.action, resourceId: auditEvent.resourceId })
        .from(auditEvent)
        .where(sql`${auditEvent.action} = 'export.cancellation.removed'`),
    );
    expect(trail.map((entry) => entry.resourceId).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it('answers the owner that the package is gone, and issues no link to it', async () => {
    const view = await org.world.api.get('/cancellation/export/administrative', org.world.owner);
    const link = await org.world.api.post(
      '/cancellation/export/administrative/download',
      org.world.owner,
    );

    expect(view.statusCode, view.body).toBe(200);
    expect(view.json<ExportPackageResponse>().package).toMatchObject({
      status: 'failed',
      failureCode: 'removed_after_archive',
      fileName: null,
    });
    expect(link.statusCode).toBe(409);
    expect(link.json<DownloadLinkResponse & { code: string }>().code).toBe(
      'export_package_not_ready',
    );
  });

  it('has nothing more to do the next time', async () => {
    expect(await clean()).toBe(0);
  });
});
