import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { onboardingState } from '../../src/db/schema/onboarding.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'onboarding-schema-a' });
  b = await createTestTenant(runtime, { slug: 'onboarding-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

describe('onboarding_state', () => {
  it('starts an organization with nothing done, no answers and nothing dismissed', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.insert(onboardingState).values({ tenantId: a.id }).returning(),
    );

    expect(row).toMatchObject({
      stepProgress: {},
      answers: {},
      currentStep: null,
      wizardCompletedAt: null,
      checklistDismissedAt: null,
    });
  });

  it('keeps one row per organization', async () => {
    // The first test of this file already inserted the row of tenant A.
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) => tx.insert(onboardingState).values({ tenantId: a.id })),
      ),
    ).toBe('23505');
  });

  it('refuses a current step that is not a step of the wizard', async () => {
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx.insert(onboardingState).values({ tenantId: b.id, currentStep: 'party' }),
        ),
      ),
    ).toBe('23514');
  });

  it('says who finished the wizard and who dismissed the checklist, or neither', async () => {
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx.insert(onboardingState).values({ tenantId: b.id, wizardCompletedAt: new Date() }),
        ),
      ),
    ).toBe('23514');
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx.insert(onboardingState).values({ tenantId: b.id, checklistDismissedBy: uuidv7() }),
        ),
      ),
    ).toBe('23514');
    const [done] = await asTenant(runtime, b.id, (tx) =>
      tx
        .insert(onboardingState)
        .values({
          tenantId: b.id,
          currentStep: 'hours',
          wizardCompletedAt: new Date(),
          wizardCompletedBy: uuidv7(),
        })
        .returning(),
    );
    expect(done?.currentStep).toBe('hours');
  });

  it('is invisible to another organization and cannot be written on its behalf', async () => {
    const seenByB = await asTenant(runtime, b.id, (tx) =>
      tx.select().from(onboardingState).where(eq(onboardingState.tenantId, a.id)),
    );
    expect(seenByB).toEqual([]);
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx
            .update(onboardingState)
            .set({ currentStep: 'team' })
            .where(eq(onboardingState.tenantId, a.id)),
        ),
      ),
    ).toBeUndefined();
    const [untouched] = await asTenant(runtime, a.id, (tx) => tx.select().from(onboardingState));
    expect(untouched?.currentStep).toBeNull();
  });

  it('can never be deleted by the application', async () => {
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.delete(onboardingState).where(eq(onboardingState.tenantId, a.id)),
        ),
      ),
    ).toBe('42501');
  });
});
