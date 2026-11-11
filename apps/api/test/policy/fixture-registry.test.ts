import { describe, expect, it } from 'vitest';

import {
  FIXTURE_FILES,
  TENANT_FIXTURES,
  mergeFixtures,
  type TenantTableFixture,
} from '../support/fixtures.js';

const fixture: TenantTableFixture = { insert: () => Promise.resolve('id') };

/**
 * The isolation suite needs a fixture for every tenant table. Since Stage 3 the fixtures are not
 * one file any more: every file of `test/support/fixtures/` adds its own, so a track that adds
 * tables adds a file and edits nothing shared.
 */
describe('the fixture registry', () => {
  it('collects the fixtures of every file in test/support/fixtures/', () => {
    expect(FIXTURE_FILES.length).toBeGreaterThan(0);
    for (const file of FIXTURE_FILES) expect(file, file).toMatch(/^\.\/fixtures\/[a-z0-9-]+\.ts$/);
    // A table that lives in that folder is part of the registry next to the core ones.
    expect(Object.keys(TENANT_FIXTURES)).toEqual(
      expect.arrayContaining(['tenant_feature', 'onboarding_state', 'care_assignment']),
    );
  });

  it('finds the first resident of the folder, the state tables of an organization', () => {
    expect(FIXTURE_FILES).toContain('./fixtures/tenant-state.ts');
  });

  it('joins the core fixtures and the ones of the files', () => {
    const merged = mergeFixtures([{ a: fixture }, { b: fixture }, {}]);

    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('refuses a table that two files both give a fixture: the second would silently win', () => {
    expect(() => mergeFixtures([{ same: fixture }, { same: fixture }])).toThrow(/same/);
  });
});
