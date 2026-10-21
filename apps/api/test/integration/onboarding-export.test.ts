import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { onboardingState } from '../../src/db/schema/onboarding.js';
import { exportOnboarding } from '../../src/modules/onboarding/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'export-onb-a' });
  b = await createTestTenant(runtime, { slug: 'export-onb-b' });
});

afterAll(async () => {
  await runtime.close();
});

describe('administrative export of the first run', () => {
  it('carries the progress of the exporting organization and nobody else', async () => {
    const finishedAt = new Date('2026-10-17T12:00:00Z');
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(onboardingState).values({
        tenantId: a.id,
        stepProgress: { branding: 'skipped' },
        answers: { isProfessional: true, path: 'solo' },
        wizardCompletedAt: finishedAt,
        wizardCompletedBy: uuidv7(),
      }),
    );
    await asTenant(runtime, b.id, (tx) =>
      tx.insert(onboardingState).values({ tenantId: b.id, answers: { path: 'center' } }),
    );

    const part = (await asTenant(runtime, a.id, (tx) =>
      exportOnboarding({ tx, tenantId: a.id }),
    )) as { progress: Record<string, unknown> | null };

    expect(part.progress).toMatchObject({
      stepProgress: { branding: 'skipped' },
      answers: { isProfessional: true, path: 'solo' },
      wizardCompletedAt: finishedAt,
      checklistDismissedAt: null,
    });
    expect(JSON.stringify(part)).not.toContain('center');
  });

  it('says there is no progress when the organization never started', async () => {
    const empty = await createTestTenant(runtime, { slug: 'export-onb-empty' });

    const part = await asTenant(runtime, empty.id, (tx) =>
      exportOnboarding({ tx, tenantId: empty.id }),
    );

    // No progress, and no signup acceptance either: the organization was created by an operator.
    expect(part).toEqual({ progress: null, termsAcceptances: [] });
  });
});
