import { describe, expect, it } from 'vitest';

import {
  auditProblems,
  revertStatements,
  type ClusterFacts,
  type Membership,
  type ScratchFacts,
} from './restore-audit.js';

const OWNER_ADMIN: Membership = {
  role: 'audit_sealer',
  member: 'app_owner',
  grantor: 'postgres',
  admin: true,
  inherit: false,
  set: false,
};
const RELEASER: Membership = {
  role: 'app_rw',
  member: 'app_releaser',
  grantor: 'postgres',
  admin: false,
  inherit: true,
  set: false,
};

const clean: ClusterFacts = {
  memberships: [OWNER_ADMIN, RELEASER],
  roleSettings: [],
  ownerPasswordHash: 'SCRAM-SHA-256$4096:aaa$bbb:ccc',
  auditPrivileges: [
    { role: 'app_rw', privilege: 'INSERT', table: 'audit_event' },
    { role: 'app_rw', privilege: 'SELECT', table: 'audit_event' },
  ],
};
const cleanScratch: ScratchFacts = {
  migrationsKind: 'r',
  databaseSettings: [],
  drizzleHooks: [],
  flags: { template: false, allowConnections: true, connectionLimit: -1 },
};

describe('what a restored database may change', () => {
  it('finds nothing wrong with a database that changed nothing', () => {
    expect(auditProblems(clean, clean, cleanScratch)).toEqual([]);
  });

  it('accepts a backup of an older version that has no migrations table yet, or fewer privileges', () => {
    expect(auditProblems(clean, clean, { ...cleanScratch, migrationsKind: null })).toEqual([]);
    expect(
      auditProblems(
        clean,
        {
          ...clean,
          auditPrivileges: [{ role: 'app_rw', privilege: 'INSERT', table: 'audit_event' }],
        },
        cleanScratch,
      ),
    ).toEqual([]);
  });

  it('refuses a migrations table that is a view, a function or anything but a table: the superuser used to read it', () => {
    for (const kind of ['v', 'm', 'f', 'p', 'S']) {
      expect(auditProblems(clean, clean, { ...cleanScratch, migrationsKind: kind })).toEqual([
        expect.stringContaining('is not a table'),
      ]);
    }
  });

  it('refuses a trigger, a rule or a policy on the tables of the migrator: the migrations would run it', () => {
    const problems = auditProblems(clean, clean, {
      ...cleanScratch,
      drizzleHooks: ['trigger boom on __drizzle_migrations'],
    });

    expect(problems).toEqual([expect.stringContaining('trigger boom')]);
  });

  it('refuses a database that is a template, does not accept connections or limits them', () => {
    for (const flags of [
      { template: true, allowConnections: true, connectionLimit: -1 },
      { template: false, allowConnections: false, connectionLimit: -1 },
      { template: false, allowConnections: true, connectionLimit: 0 },
    ]) {
      expect(auditProblems(clean, clean, { ...cleanScratch, flags })).toEqual([
        expect.stringContaining('flags of the database'),
      ]);
    }
  });

  it('refuses a dump that sets a parameter of its database', () => {
    const problems = auditProblems(clean, clean, {
      ...cleanScratch,
      databaseSettings: ['search_path=public, evil'],
    });

    expect(problems).toEqual([expect.stringContaining('search_path=public, evil')]);
  });

  it('refuses a dump that grants audit_sealer to another role', () => {
    const hostile: ClusterFacts = {
      ...clean,
      memberships: [
        ...clean.memberships,
        {
          role: 'audit_sealer',
          member: 'app_rw',
          grantor: 'app_owner',
          admin: false,
          inherit: false,
          set: true,
        },
      ],
    };

    expect(auditProblems(clean, hostile, cleanScratch)).toEqual([
      'a new role membership: audit_sealer to app_rw',
    ]);
  });

  it('refuses a dump that changes how a membership is held, or takes one away', () => {
    const widened: ClusterFacts = {
      ...clean,
      memberships: [{ ...RELEASER, set: true }, OWNER_ADMIN],
    };
    const dropped: ClusterFacts = { ...clean, memberships: [OWNER_ADMIN] };

    expect(auditProblems(clean, widened, cleanScratch).length).toBeGreaterThan(0);
    expect(auditProblems(clean, dropped, cleanScratch)).toEqual([
      'a role membership was taken away: app_rw to app_releaser',
    ]);
  });

  it('refuses a dump that sets a parameter for a role, changes the password of app_owner or opens the audit trail', () => {
    const problems = auditProblems(
      clean,
      {
        ...clean,
        roleSettings: ['app_owner=search_path=evil'],
        ownerPasswordHash: 'SCRAM-SHA-256$4096:zzz$yyy:xxx',
        auditPrivileges: [
          ...clean.auditPrivileges,
          { role: 'app_rw', privilege: 'UPDATE', table: 'audit_event' },
        ],
      },
      cleanScratch,
    );

    expect(problems).toEqual([
      expect.stringContaining('app_owner=search_path=evil'),
      'the password of app_owner was changed',
      'more privileges on the audit trail: {"role":"app_rw","privilege":"UPDATE","table":"audit_event"}',
    ]);
  });
});

describe('putting the cluster back', () => {
  it('revokes a membership that appeared, grants back one that went, resets role parameters and the password', () => {
    const hostile: ClusterFacts = {
      memberships: [
        OWNER_ADMIN,
        {
          role: 'audit_sealer',
          member: 'app_rw',
          grantor: 'app_owner',
          admin: false,
          inherit: false,
          set: true,
        },
      ],
      roleSettings: ['app_owner=search_path=evil'],
      ownerPasswordHash: 'SCRAM-SHA-256$4096:zzz$yyy:xxx',
      auditPrivileges: clean.auditPrivileges,
    };

    expect(revertStatements(clean, hostile, "the'password")).toEqual([
      'REVOKE "audit_sealer" FROM "app_rw" GRANTED BY "app_owner"',
      'GRANT "app_rw" TO "app_releaser" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY "postgres"',
      'ALTER ROLE "app_owner" RESET ALL',
      `ALTER ROLE "app_owner" PASSWORD 'the''password'`,
    ]);
  });

  it('has nothing to do when nothing changed, and refuses a name that is not a plain role name', () => {
    expect(revertStatements(clean, clean, 'x')).toEqual([]);
    expect(() =>
      revertStatements(
        clean,
        { ...clean, memberships: [{ ...OWNER_ADMIN, member: 'a"; DROP ROLE app_rw; --' }] },
        'x',
      ),
    ).toThrow(/unsafe role name/);
  });
});
