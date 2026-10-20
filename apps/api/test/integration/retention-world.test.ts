import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportPackage } from '../../src/db/schema/export-package.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createRetentionWorld, type RetentionWorld } from '../support/retention-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * The test files share one database, so an organization that another file cancelled and did not
 * export is still waiting when this one asks the worker to look for requests. The helper that builds
 * the packages of a test world must build ITS packages only: the other organization's records are
 * sealed with the keys of another world, and running its job here once failed a whole suite with a
 * `DecryptionError` (the file that did it depended on the order Vitest picked).
 */

let runtime: DbHandle;
let foreign: RetentionWorld;
let own: RetentionWorld;

async function cancelledWithAnEntry(world: RetentionWorld, text: string) {
  const doctor = await world.world.professional();
  const patient = await world.world.patient([doctor]);
  await world.signedEntry(doctor, patient, { reasonForConsultation: text });
  const cancelled = await world.cancel();
  expect(cancelled.statusCode, cancelled.body).toBe(200);
}

const statusesOf = (world: RetentionWorld) =>
  asTenant(runtime, world.world.tenant.id, (tx) =>
    tx
      .select({ kind: exportPackage.kind, status: exportPackage.status })
      .from(exportPackage)
      .orderBy(asc(exportPackage.kind), asc(exportPackage.createdAt)),
  );

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  // Another file's organization: cancelled, with clinical records, its packages never built.
  foreign = await createRetentionWorld(runtime, 'foreign-queued-export');
  await cancelledWithAnEntry(foreign, 'Registro de otro mundo');
  own = await createRetentionWorld(runtime, 'own-queued-export');
  await cancelledWithAnEntry(own, 'Registro propio');
}, 300_000);

afterAll(async () => {
  await foreign.close();
  await own.close();
  await runtime.close();
});

describe('building the packages of a test world', () => {
  it('builds the packages of its own organization', async () => {
    expect((await statusesOf(own)).every((row) => row.status === 'queued')).toBe(true);

    await own.buildPackages();

    const rows = await statusesOf(own);
    expect(rows.map((row) => row.kind)).toEqual(['administrative', 'clinical']);
    expect(rows.map((row) => row.status)).toEqual(['ready', 'ready']);
  });

  it('leaves the queued request of another organization of the database alone', async () => {
    const rows = await statusesOf(foreign);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((row) => row.status)).toEqual(rows.map(() => 'queued'));
  });
});
