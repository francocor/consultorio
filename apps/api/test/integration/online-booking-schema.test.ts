import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bookingLink } from '../../src/db/schema/online-booking.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertProfessional } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'booking-schema-a' });
  b = await createTestTenant(runtime, { slug: 'booking-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

const slug = () => randomBytes(8).toString('hex');
const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

describe('booking_link', () => {
  it('starts disabled and exposes nothing until somebody chooses', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.insert(bookingLink).values({ tenantId: a.id, slug: slug() }).returning(),
    );

    expect(row).toMatchObject({
      enabled: false,
      professionalId: null,
      locationIds: [],
      typeIds: [],
      regeneratedAt: null,
    });
  });

  it('refuses a slug that is already taken, even by another organization', async () => {
    const taken = slug();
    await asTenant(runtime, a.id, async (tx) => {
      const professionalId = await insertProfessional(tx, a.id);
      await tx.insert(bookingLink).values({ tenantId: a.id, professionalId, slug: taken });
    });

    const duplicate = await dbError(
      asTenant(runtime, b.id, (tx) =>
        tx.insert(bookingLink).values({ tenantId: b.id, slug: taken }),
      ),
    );

    expect(duplicate).toBe('23505');
  });

  it('refuses a second link of the organization itself, and a second one for a professional', async () => {
    // Tenant A already has its organization link from the first test.
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(bookingLink).values({ tenantId: a.id, slug: slug() }),
        ),
      ),
    ).toBe('23505');

    const professionalId = await asTenant(runtime, b.id, async (tx) => {
      const id = await insertProfessional(tx, b.id);
      await tx.insert(bookingLink).values({ tenantId: b.id, professionalId: id, slug: slug() });
      return id;
    });
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx.insert(bookingLink).values({ tenantId: b.id, professionalId, slug: slug() }),
        ),
      ),
    ).toBe('23505');
  });

  it.each(['SHORT', 'has space!', 'UPPERCASE12345678', 'x'.repeat(33), 'a-b-c-d-e-f-g'])(
    'refuses the slug %j: only lowercase letters and digits, 8 to 32 of them',
    async (value) => {
      expect(
        await dbError(
          asTenant(runtime, b.id, async (tx) => {
            const professionalId = await insertProfessional(tx, b.id);
            await tx.execute(
              sql`INSERT INTO booking_link (tenant_id, professional_id, slug)
                    VALUES (${b.id}, ${professionalId}, ${value})`,
            );
          }),
        ),
      ).toBe('23514');
    },
  );

  it('keeps the organizations apart', async () => {
    const seenByB = await asTenant(runtime, b.id, (tx) => tx.select().from(bookingLink));

    expect(seenByB.every((row) => row.tenantId === b.id)).toBe(true);
  });
});
