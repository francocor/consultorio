/**
 * What a restored database may and may not have changed, decided from facts that are read from the cluster.
 *
 * A backup is a program for `pg_restore`: it runs SQL, as `app_owner`, inside the scratch database, and
 * `app_owner` can do more than create tables. It can grant `audit_sealer` to another role (it holds the admin
 * option, so that migration 0020 could revoke the old membership), it can set the parameters of its own database
 * and role, it can change its own password, and it can make `drizzle.__drizzle_migrations` something other than
 * a table. None of that is in the application's own database, so a restore compares what it finds with what
 * the live cluster looked like before it started, and refuses (and puts back) anything that differs.
 */

/** One privilege of one application role on one table of the audit trail. */
export interface AuditPrivilege {
  role: string;
  privilege: string;
  table: string;
}

const privilegeKey = (privilege: AuditPrivilege) =>
  JSON.stringify([privilege.role, privilege.privilege, privilege.table]);

/** One row of `pg_auth_members`, with the names of the roles. */
export interface Membership {
  role: string;
  member: string;
  grantor: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

/** The cluster-wide facts a restore must leave as they were. */
export interface ClusterFacts {
  /** Memberships among the roles of the application. */
  memberships: Membership[];
  /**
   * `pg_db_role_setting` of the roles of the application, in every database: `role=name=value` for the setting
   * of the role everywhere, `role@database=name=value` for the one it has only in a database.
   */
  roleSettings: string[];
  /** The stored password verifier of `app_owner`: a restored dump can change its own. */
  ownerPasswordHash: string;
  /** What the application roles may do to the audit trail, one tuple of catalog columns each. */
  auditPrivileges: AuditPrivilege[];
}

/** What the server says about a database itself. */
export interface DatabaseFlags {
  template: boolean;
  allowConnections: boolean;
  connectionLimit: number;
}

/** The flags of a database that was just created. */
export const NEW_DATABASE_FLAGS: DatabaseFlags = {
  template: false,
  allowConnections: true,
  connectionLimit: -1,
};

/** What is true of the scratch database itself. */
export interface ScratchFacts {
  /** `pg_class.relkind` of `drizzle.__drizzle_migrations`: `r` is a plain table; null when there is none. */
  migrationsKind: string | null;
  /** `pg_db_role_setting` of this database (`ALTER DATABASE ... SET`): `name=value`. */
  databaseSettings: string[];
  /**
   * Triggers, rules and policies on the tables of the schema `drizzle`, as `kind name on table`: the migrator
   * reads and writes those tables as `app_owner`, and a hook there is code of the backup that runs with its power.
   */
  drizzleHooks: string[];
  /** `IS_TEMPLATE`, `ALLOW_CONNECTIONS` and `CONNECTION LIMIT` of the database. */
  flags: DatabaseFlags;
}

const key = (membership: Membership) =>
  [
    membership.role,
    membership.member,
    membership.grantor,
    membership.admin ? 'admin' : '',
    membership.inherit ? 'inherit' : '',
    membership.set ? 'set' : '',
  ].join('|');

const roleAndMember = (membership: Membership) => `${membership.role} to ${membership.member}`;

/**
 * Everything that is wrong with a restored database, in words for the log. Empty means nothing is.
 *
 * `auditPrivileges` is compared one way only: more than the live database has is a problem (an older backup may
 * legitimately have fewer, and the migrations that come after the restore add the rest).
 */
export function auditProblems(
  before: ClusterFacts,
  after: ClusterFacts,
  scratch: ScratchFacts,
): string[] {
  return [...scratchProblems(scratch), ...clusterProblems(before, after)];
}

/** What is wrong with the scratch database itself. */
function scratchProblems(scratch: ScratchFacts): string[] {
  const problems: string[] = [];
  if (scratch.migrationsKind !== null && scratch.migrationsKind !== 'r') {
    problems.push(
      `drizzle.__drizzle_migrations is not a table (it is "${scratch.migrationsKind}"): the superuser reads it`,
    );
  }
  if (scratch.databaseSettings.length > 0) {
    problems.push(`the database sets parameters: ${JSON.stringify(scratch.databaseSettings)}`);
  }
  if (scratch.drizzleHooks.length > 0) {
    problems.push(`the tables of the migrator have hooks: ${JSON.stringify(scratch.drizzleHooks)}`);
  }
  if (JSON.stringify(scratch.flags) !== JSON.stringify(NEW_DATABASE_FLAGS)) {
    problems.push(
      `the flags of the database are not those of a new one: ${JSON.stringify(scratch.flags)}`,
    );
  }
  return problems;
}

/**
 * What differs in the roles of the cluster from how `before` had them. Read from the superuser side alone: a hook that
 * changes the password of `app_owner` or sets a timeout on it makes every connection through `app_owner` fail, so
 * this is compared BEFORE anything reads through it, and the difference is reported instead of thrown.
 */
export function clusterProblems(before: ClusterFacts, after: ClusterFacts): string[] {
  const problems: string[] = [];
  const wasBefore = new Set(before.memberships.map(key));
  const isNow = new Set(after.memberships.map(key));
  for (const membership of after.memberships) {
    if (!wasBefore.has(key(membership))) {
      problems.push(`a new role membership: ${roleAndMember(membership)}`);
    }
  }
  for (const membership of before.memberships) {
    if (!isNow.has(key(membership))) {
      problems.push(`a role membership was taken away: ${roleAndMember(membership)}`);
    }
  }
  const settingsBefore = new Set(before.roleSettings);
  const settingsNow = new Set(after.roleSettings);
  for (const setting of after.roleSettings) {
    if (!settingsBefore.has(setting))
      problems.push(`a role sets a parameter: ${JSON.stringify(setting)}`);
  }
  for (const setting of before.roleSettings) {
    if (!settingsNow.has(setting))
      problems.push(`a parameter of a role was taken away: ${JSON.stringify(setting)}`);
  }
  if (after.ownerPasswordHash !== before.ownerPasswordHash) {
    problems.push('the password of app_owner was changed');
  }
  const privilegesBefore = new Set(before.auditPrivileges.map(privilegeKey));
  for (const privilege of after.auditPrivileges) {
    if (!privilegesBefore.has(privilegeKey(privilege))) {
      problems.push(`more privileges on the audit trail: ${JSON.stringify(privilege)}`);
    }
  }
  return problems;
}

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe role name: ${name}`);
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const SAFE_PARAMETER = /^[a-z_][a-z0-9_.]*$/;

/** A setting of the list `roleSettings`, taken apart. */
function parseRoleSetting(
  entry: string,
): { role: string; database: string | null; name: string; value: string } | null {
  const equals = entry.indexOf('=');
  if (equals < 0) return null;
  const head = entry.slice(0, equals);
  const setting = entry.slice(equals + 1);
  const at = head.indexOf('@');
  const role = at < 0 ? head : head.slice(0, at);
  const database = at < 0 ? null : head.slice(at + 1);
  const inner = setting.indexOf('=');
  if (inner < 0) return null;
  return { role, database, name: setting.slice(0, inner), value: setting.slice(inner + 1) };
}

/** The statements that put the cluster back, and what could not be turned into one. */
export interface RevertPlan {
  statements: string[];
  /** Why a statement was left out (a name that is not a plain identifier): the revert is NOT complete if any. */
  skipped: string[];
}

/**
 * The statements that put the cluster back as `before` had it, run as the superuser in the `postgres` database
 * (never inside a restored one). The password of `app_owner` comes first (it is what every other connection of the
 * application needs), then the parameters of the roles (the global ones and the ones in a database: each row that
 * differs is reset and given the values it had), then the memberships that appeared are revoked and the ones that
 * went are granted again. A name that is not safe to write into a statement skips that statement alone.
 */
export function planRevert(
  before: ClusterFacts,
  after: ClusterFacts,
  ownerPassword: string,
): RevertPlan {
  const statements: string[] = [];
  const skipped: string[] = [];
  const add = (build: () => string, what: string) => {
    try {
      statements.push(build());
    } catch (error) {
      skipped.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (after.ownerPasswordHash !== before.ownerPasswordHash) {
    add(
      () => `ALTER ROLE "app_owner" PASSWORD ${literal(ownerPassword)}`,
      'the password of app_owner',
    );
  }

  // Rows of pg_db_role_setting that differ, by (role, database).
  const rowOf = (entry: string) => {
    const parsed = parseRoleSetting(entry);
    return parsed === null ? null : `${parsed.role}@${parsed.database ?? ''}`;
  };
  const differing = new Set<string>();
  const was = new Set(before.roleSettings);
  const is = new Set(after.roleSettings);
  for (const entry of after.roleSettings) if (!was.has(entry)) differing.add(rowOf(entry) ?? entry);
  for (const entry of before.roleSettings) if (!is.has(entry)) differing.add(rowOf(entry) ?? entry);
  for (const row of differing) {
    const at = row.indexOf('@');
    const role = at < 0 ? row : row.slice(0, at);
    const database = at < 0 || row.slice(at + 1) === '' ? null : row.slice(at + 1);
    const target = () =>
      `ALTER ROLE ${identifier(role)}${database === null ? '' : ` IN DATABASE ${identifier(database)}`}`;
    add(() => `${target()} RESET ALL`, `the parameters of ${row}`);
    for (const entry of before.roleSettings) {
      const parsed = parseRoleSetting(entry);
      if (parsed === null || parsed.role !== role || parsed.database !== database) continue;
      add(() => {
        if (!SAFE_PARAMETER.test(parsed.name))
          throw new Error(`unsafe parameter name: ${parsed.name}`);
        return `${target()} SET ${parsed.name} TO ${literal(parsed.value)}`;
      }, `a parameter of ${row}`);
    }
  }

  const wasBefore = new Set(before.memberships.map(key));
  const isNow = new Set(after.memberships.map(key));
  for (const membership of after.memberships) {
    if (wasBefore.has(key(membership))) continue;
    add(
      () =>
        `REVOKE ${identifier(membership.role)} FROM ${identifier(membership.member)} GRANTED BY ${identifier(membership.grantor)}`,
      `a membership: ${roleAndMember(membership)}`,
    );
  }
  for (const membership of before.memberships) {
    if (isNow.has(key(membership))) continue;
    add(
      () =>
        `GRANT ${identifier(membership.role)} TO ${identifier(membership.member)} WITH ADMIN ${membership.admin ? 'TRUE' : 'FALSE'}, INHERIT ${membership.inherit ? 'TRUE' : 'FALSE'}, SET ${membership.set ? 'TRUE' : 'FALSE'} GRANTED BY ${identifier(membership.grantor)}`,
      `a membership: ${roleAndMember(membership)}`,
    );
  }
  return { statements, skipped };
}

/** The statements of `planRevert`, for the callers that do not care about what was skipped. */
export function revertStatements(
  before: ClusterFacts,
  after: ClusterFacts,
  ownerPassword: string,
): string[] {
  return planRevert(before, after, ownerPassword).statements;
}
