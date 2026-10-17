import { readFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { onboardingState } from '../../src/db/schema/onboarding.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

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

describe('the backfill of a finished wizard for organizations that are already running (JD-S2 C9)', () => {
  const migration = readFileSync(
    new URL('../../src/db/migrations/0039_onboarding_backfill.sql', import.meta.url),
    'utf8',
  );

  it('marks the wizard finished where there is staff or a professional, and only there', async () => {
    const withStaff = await createTestTenant(runtime, { slug: 'onb-backfill-staff' });
    await createTestUser(runtime, withStaff.id, { roles: ['owner'] });
    await createTestUser(runtime, withStaff.id, { roles: ['reception'] });
    const withProfessional = await createTestTenant(runtime, { slug: 'onb-backfill-prof' });
    await createTestProfessional(runtime, withProfessional.id, { alsoRoles: ['owner'] });
    const startedWithStaff = await createTestTenant(runtime, { slug: 'onb-backfill-started' });
    await createTestUser(runtime, startedWithStaff.id, { roles: ['owner'] });
    await createTestUser(runtime, startedWithStaff.id, { roles: ['admin'] });
    await asTenant(runtime, startedWithStaff.id, (tx) =>
      tx
        .insert(onboardingState)
        .values({ tenantId: startedWithStaff.id, answers: { isProfessional: false } }),
    );
    const justTheOwner = await createTestTenant(runtime, { slug: 'onb-backfill-owner' });
    await createTestUser(runtime, justTheOwner.id, { roles: ['owner'] });
    const demo = await createTestTenant(runtime, { slug: 'onb-backfill-demo', isDemo: true });
    await createTestUser(runtime, demo.id, { roles: ['owner'] });
    await createTestUser(runtime, demo.id, { roles: ['reception'] });

    const owner = new pg.Client({ connectionString: inject('ownerUrl') });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      for (const statement of migration.split('\n--> statement-breakpoint\n')) {
        if (statement.trim() !== '') await owner.query(statement);
      }
      const stateOf = async (tenant: TestTenant) => {
        await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
        const result = await owner.query<{
          wizard_completed_at: Date | null;
          wizard_completed_by: string | null;
          answers: Record<string, unknown>;
        }>('SELECT wizard_completed_at, wizard_completed_by, answers FROM onboarding_state');
        return result.rows[0];
      };

      const staffState = await stateOf(withStaff);
      const professionalState = await stateOf(withProfessional);
      const startedState = await stateOf(startedWithStaff);
      expect(staffState?.wizard_completed_at).not.toBeNull();
      expect(staffState?.wizard_completed_by).not.toBeNull();
      expect(professionalState?.wizard_completed_at).not.toBeNull();
      expect(startedState?.wizard_completed_at).not.toBeNull();
      // What the owner had answered is kept.
      expect(startedState?.answers).toEqual({ isProfessional: false });
      expect(await stateOf(justTheOwner)).toBeUndefined();
      expect(await stateOf(demo)).toBeUndefined();
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
  });
});
