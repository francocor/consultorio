import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bookingLink } from '../../src/db/schema/online-booking.js';
import { exportOnlineBooking } from '../../src/modules/online-booking/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'export-booking-a' });
  b = await createTestTenant(runtime, { slug: 'export-booking-b' });
});

afterAll(async () => {
  await runtime.close();
});

const slug = () => randomBytes(8).toString('hex');

describe('administrative export of the online booking', () => {
  it('lists the booking links of the exporting organization, and nobody else', async () => {
    const { professionalId } = await createTestProfessional(runtime, a.id);
    await asTenant(runtime, a.id, async (tx) => {
      await tx.insert(bookingLink).values({ tenantId: a.id, slug: slug(), enabled: true });
      await tx.insert(bookingLink).values({ tenantId: a.id, professionalId, slug: slug() });
    });
    await asTenant(runtime, b.id, (tx) =>
      tx.insert(bookingLink).values({ tenantId: b.id, slug: slug() }),
    );

    const part = (await asTenant(runtime, a.id, (tx) =>
      exportOnlineBooking({ tx, tenantId: a.id }),
    )) as { bookingLinks: { professionalId: string | null; enabled: boolean; slug: string }[] };

    expect(part.bookingLinks).toHaveLength(2);
    expect(part.bookingLinks.filter((link) => link.professionalId === null)).toHaveLength(1);
    expect(part.bookingLinks.find((link) => link.professionalId === null)?.enabled).toBe(true);
  });

  it('carries no submission data: those rows are transient and encrypted', async () => {
    const part = await asTenant(runtime, a.id, (tx) => exportOnlineBooking({ tx, tenantId: a.id }));

    expect(JSON.stringify(part)).not.toMatch(/payload|_enc|otp|code_hash/i);
  });
});
