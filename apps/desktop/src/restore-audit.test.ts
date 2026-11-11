import { describe, expect, it } from 'vitest';

import {
  auditProblems,
  clusterProblems,
  parseClusterFacts,
  planRevert,
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
  databaseFlags: { consultorio: { template: false, allowConnections: true, connectionLimit: -1 } },
  databaseParameters: [],
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

describe('what the roles of the cluster may have lost, read from the cluster alone', () => {
  it('finds a changed password, a parameter and a membership without needing the database of the backup', () => {
    const hostile: ClusterFacts = {
      ...clean,
      ownerPasswordHash: 'SCRAM-SHA-256$4096:zzz$bbb:ccc',
      roleSettings: ['app_owner=statement_timeout=1ms'],
    };

    expect(clusterProblems(clean, clean)).toEqual([]);
    expect(clusterProblems(clean, hostile)).toEqual([
      expect.stringContaining('statement_timeout=1ms'),
      'the password of app_owner was changed',
    ]);
  });
});

describe('the databases the owner can reach', () => {
  const tampered: ClusterFacts = {
    ...clean,
    databaseFlags: {
      ...clean.databaseFlags,
      consultorio: { template: false, allowConnections: false, connectionLimit: 0 },
    },
    databaseParameters: ['consultorio=statement_timeout=1ms'],
  };

  it('are compared: flags that changed and a parameter set for the whole database are findings', () => {
    expect(clusterProblems(clean, clean)).toEqual([]);
    expect(clusterProblems(clean, tampered)).toEqual([
      expect.stringContaining('the flags of the database consultorio changed'),
      expect.stringContaining('consultorio=statement_timeout=1ms'),
    ]);
  });

  it('are put back: the flags first, then the parameters of the database', () => {
    const { statements, skipped } = planRevert(clean, tampered, 'owner-password');

    expect(skipped).toEqual([]);
    expect(statements).toEqual([
      'ALTER DATABASE "consultorio" WITH IS_TEMPLATE false ALLOW_CONNECTIONS true CONNECTION LIMIT -1',
      'ALTER DATABASE "consultorio" RESET ALL',
    ]);
  });

  it('are given back the parameters they had', () => {
    const had: ClusterFacts = { ...clean, databaseParameters: ['consultorio=work_mem=8MB'] };

    const { statements } = planRevert(had, tampered, 'owner-password');

    expect(statements).toContain('ALTER DATABASE "consultorio" RESET ALL');
    expect(statements).toContain('ALTER DATABASE "consultorio" SET work_mem TO \'8MB\'');
  });
});

describe('the facts as the record of a restore holds them', () => {
  it('are accepted whole, and refused when they are not of the shape', () => {
    expect(parseClusterFacts(JSON.parse(JSON.stringify(clean)))).toEqual(clean);
    expect(parseClusterFacts({ ...clean, memberships: 'none' })).toBeNull();
    expect(
      parseClusterFacts({ ...clean, databaseFlags: { consultorio: { template: 1 } } }),
    ).toBeNull();
    expect(parseClusterFacts('roles')).toBeNull();
  });
});

describe('the parameters a role has in a database', () => {
  const hostile: ClusterFacts = {
    ...clean,
    roleSettings: ['app_owner@consultorio=statement_timeout=1ms', 'app_rw@postgres=work_mem=1TB'],
  };

  it('are found whichever database they are for', () => {
    expect(clusterProblems(clean, hostile)).toEqual([
      expect.stringContaining('app_owner@consultorio=statement_timeout=1ms'),
      expect.stringContaining('app_rw@postgres=work_mem=1TB'),
    ]);
  });

  it('are found when one is taken away too', () => {
    const had: ClusterFacts = { ...clean, roleSettings: ['app_owner@consultorio=work_mem=8MB'] };

    expect(clusterProblems(had, clean)).toEqual([expect.stringContaining('was taken away')]);
  });

  it('are reset where they are, in the database they were written for, and the global row is left alone', () => {
    const { statements, skipped } = planRevert(clean, hostile, 'owner-password');

    expect(skipped).toEqual([]);
    expect(statements).toContain('ALTER ROLE "app_owner" IN DATABASE "consultorio" RESET ALL');
    expect(statements).toContain('ALTER ROLE "app_rw" IN DATABASE "postgres" RESET ALL');
    expect(statements).not.toContain('ALTER ROLE "app_owner" RESET ALL');
  });

  it('are given back the values they had, row by row', () => {
    const had: ClusterFacts = {
      ...clean,
      roleSettings: ['app_owner=search_path=public', 'app_owner@consultorio=work_mem=8MB'],
    };
    const now: ClusterFacts = {
      ...clean,
      roleSettings: ['app_owner=search_path=public', 'app_owner@consultorio=work_mem=1TB'],
    };

    const { statements } = planRevert(had, now, 'owner-password');

    expect(statements).toEqual([
      'ALTER ROLE "app_owner" IN DATABASE "consultorio" RESET ALL',
      'ALTER ROLE "app_owner" IN DATABASE "consultorio" SET work_mem TO \'8MB\'',
    ]);
  });
});

describe('the way back', () => {
  it('starts with the password of app_owner: it is what every other connection of the application needs', () => {
    const changed: ClusterFacts = {
      ...clean,
      ownerPasswordHash: 'other',
      roleSettings: ['app_owner=statement_timeout=1ms'],
      memberships: [...clean.memberships, { ...RELEASER, role: 'audit_sealer', member: 'app_rw' }],
    };

    const { statements } = planRevert(clean, changed, 'owner-password');

    expect(statements[0]).toBe('ALTER ROLE "app_owner" PASSWORD \'owner-password\'');
    expect(statements.length).toBeGreaterThan(2);
  });

  it('skips only the statement whose name is not safe, and says which', () => {
    const odd: ClusterFacts = {
      ...clean,
      memberships: [
        ...clean.memberships,
        { ...RELEASER, role: 'audit_sealer', member: 'Weird"Name' },
        { ...RELEASER, role: 'audit_sealer', member: 'app_rw' },
      ],
      ownerPasswordHash: 'other',
    };

    const { statements, skipped } = planRevert(clean, odd, 'owner-password');

    expect(statements).toContain('ALTER ROLE "app_owner" PASSWORD \'owner-password\'');
    expect(statements.some((statement) => statement.includes('"app_rw"'))).toBe(true);
    expect(skipped).toEqual([expect.stringContaining('unsafe role name')]);
  });
});

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
        databaseFlags: clean.databaseFlags,
        databaseParameters: [],
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
      databaseFlags: clean.databaseFlags,
      databaseParameters: [],
      auditPrivileges: clean.auditPrivileges,
    };

    expect(revertStatements(clean, hostile, "the'password")).toEqual([
      `ALTER ROLE "app_owner" PASSWORD 'the''password'`,
      'ALTER ROLE "app_owner" RESET ALL',
      'REVOKE "audit_sealer" FROM "app_rw" GRANTED BY "app_owner"',
      'GRANT "app_rw" TO "app_releaser" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY "postgres"',
    ]);
  });

  it('has nothing to do when nothing changed, and leaves out (and says so) a name that is not a plain role name', () => {
    expect(revertStatements(clean, clean, 'x')).toEqual([]);

    const plan = planRevert(
      clean,
      { ...clean, memberships: [{ ...OWNER_ADMIN, member: 'a"; DROP ROLE app_rw; --' }] },
      'x',
    );

    expect(plan.statements).toHaveLength(2);
    expect(plan.statements.every((statement) => statement.startsWith('GRANT'))).toBe(true);
    expect(plan.skipped).toEqual([expect.stringContaining('unsafe role name')]);
  });
});
