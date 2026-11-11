import { describe, expect, it } from 'vitest';

import { ALLOWLIST, mergeAllowlists, type Allowlist } from './no-delete-allowlist.js';

const empty: Allowlist = { code: [], sql: [], ephemeralTables: [] };

describe('the no-delete allowlist', () => {
  it('joins the base list and the files each track adds in test/policy/no-delete/', () => {
    const merged = mergeAllowlists([
      {
        ...empty,
        code: [{ file: 'src/a.ts', table: 'a', why: 'A reason that is long enough to count.' }],
      },
      {
        ...empty,
        ephemeralTables: [{ table: 'otp_challenge', why: 'A code that expires within minutes.' }],
      },
    ]);

    expect(merged.code.map((entry) => entry.table)).toEqual(['a']);
    expect(merged.ephemeralTables.map((entry) => entry.table)).toEqual(['otp_challenge']);
  });

  it('refuses an entry that two files both list: one of them is stale', () => {
    const entry = { table: 'otp_challenge', why: 'A code that expires within minutes.' };

    expect(() =>
      mergeAllowlists([
        { ...empty, ephemeralTables: [entry] },
        { ...empty, ephemeralTables: [entry] },
      ]),
    ).toThrow(/otp_challenge/);
  });

  it('is the committed list when no track added a file', () => {
    expect(ALLOWLIST.ephemeralTables.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['action_token', 'session']),
    );
    expect(ALLOWLIST.code.length).toBeGreaterThan(0);
  });
});
