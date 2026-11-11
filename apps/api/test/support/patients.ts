import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { patient } from '../../src/db/schema/patients.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';

let counter = 0;

/** A patient row written straight to the database, for tests that are not about registration. */
export async function createTestPatient(
  handle: DbHandle,
  tenantId: string,
  values: Partial<typeof patient.$inferInsert> = {},
): Promise<string> {
  counter += 1;
  const id = values.id ?? randomUUID();
  await createWithTenant(handle.db)({ tenantId, userId: randomUUID() }, (tx) =>
    tx.insert(patient).values({
      familyName: `Paciente${String(counter)}`,
      givenNames: 'De Prueba',
      birthDate: '1990-01-01',
      ...values,
      id,
      tenantId,
    }),
  );
  return id;
}

/** Makes sure a patient with this id exists in the tenant (idempotent). */
export async function ensureTestPatient(
  handle: DbHandle,
  tenantId: string,
  id: string,
): Promise<void> {
  const found = await createWithTenant(handle.db)({ tenantId, userId: randomUUID() }, (tx) =>
    tx.select({ id: patient.id }).from(patient).where(eq(patient.id, id)),
  );
  if (found.length === 0) await createTestPatient(handle, tenantId, { id });
}
