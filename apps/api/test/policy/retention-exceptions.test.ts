import { describe, expect, it } from 'vitest';

import { ALLOWLIST } from './no-delete-allowlist.js';

/**
 * The rule "records are never hard-deleted" has exactly four exceptions (tenancy, "Retention
 * exceptions are explicit and exhaustive"): (1) the reset of a demo organization, (2) the purge of
 * the signups nobody confirmed, (3) the legally required erasure of archived records, and (4) the
 * purge of abandoned, unverified booking submissions. The allowlist of deletes names each one that
 * exists, and no path may claim a fifth.
 */
const entries = [...ALLOWLIST.code, ...ALLOWLIST.sql].map((entry) => ({
  file: entry.file,
  why: entry.why,
}));

/** The number of the exception an entry says it is, when it says so. */
function exceptionOf(why: string): number | null {
  const named = /retention exception (\d)/i.exec(why);
  return named?.[1] === undefined ? null : Number(named[1]);
}

describe('the retention exceptions in the allowlist of deletes', () => {
  it('claims no exception beyond the four of the tenancy rule', () => {
    const claimed = entries.map((entry) => exceptionOf(entry.why)).filter((n) => n !== null);

    expect(claimed.length).toBeGreaterThan(0);
    for (const number of claimed) expect([1, 2, 3, 4]).toContain(number);
  });

  it('names the purge of unverified signups as exception 2, in the migration that makes it', () => {
    const second = entries.filter((entry) => exceptionOf(entry.why) === 2);

    // The migration that makes it, and the one that replaced the function to stop stuck rows from
    // starving the others (JD-S6 R1-A-T5): the same exception, the same list of tables.
    expect(second.map((entry) => entry.file)).toEqual([
      'src/db/migrations/0640_signup.sql',
      'src/db/migrations/0685_signup_set_password_at_verify.sql',
    ]);
    expect(second[0]?.why).toMatch(/never younger than a day/);
    expect(second[0]?.why).toMatch(/foreign key/);
  });

  it('names the purge of abandoned booking submissions as exception 4', () => {
    const fourth = entries.filter((entry) => exceptionOf(entry.why) === 4);

    expect(fourth.map((entry) => entry.file)).toContain(
      'src/modules/online-booking/application/purge.ts',
    );
  });

  it('keeps the reset of a demo organization (exception 1) in the migrations that make it', () => {
    const files = entries.map((entry) => entry.file);

    expect(files).toContain('src/db/migrations/0018_demo_reset.sql');
  });

  it('has no other path that deletes organizations: the signup purge is the only entry about them', () => {
    const aboutOrganizations = entries.filter((entry) =>
      /organization that was never confirmed/i.test(entry.why),
    );

    expect(aboutOrganizations).toHaveLength(1);
  });
});
