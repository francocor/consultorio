/**
 * The privileges of a database, as facts, and the statements that give a restored database the privileges the
 * live one has.
 *
 * A restore runs `pg_restore` as a throwaway role with `--no-privileges`, so everything it creates is owned by
 * that role and has no grants at all. Two things follow:
 *
 * - whatever ACL it finds afterwards was put there by SQL inside the dump (a `GRANT` can be hidden in the
 *   definition of any entry, whatever the entry says it is), so a restored database whose ACLs differ from the
 *   empty state it started in is refused (`aclChanges`);
 * - the grants the application needs (`app_rw` reads the tables, the sealer updates three columns, and so on) are
 *   not taken from the dump but from the LIVE database, which only the application and earlier restores that
 *   passed this very check have written (`trustedGrants`). It is the one source that covers every grant, column
 *   grants and default privileges included, without the shell having to know what the migrations grant; and a
 *   migration written tomorrow is covered the day it runs.
 */

export type AclKind =
  | 'database'
  | 'schema'
  | 'relation'
  | 'column'
  | 'routine'
  | 'type'
  | 'language'
  | 'fdw'
  | 'server'
  | 'largeobject'
  | 'default';

/** One privilege of one grantee on one object, as `aclexplode` lists it, with the names of the roles. */
export interface AclEntry {
  kind: AclKind;
  /** The schema of the object; for a default privilege, the schema it is `IN SCHEMA` of (empty when global). */
  schema: string;
  name: string;
  /** The identity arguments of a routine. */
  args: string;
  /** The column of a column privilege. */
  column: string;
  /** `pg_class.relkind`, `pg_proc.prokind`, `pg_type.typtype`, or `pg_default_acl.defaclobjtype`. */
  objtype: string;
  /** The owner of the object; for a default privilege, the role it is `FOR ROLE` of. */
  owner: string;
  /** A role, or `PUBLIC`. */
  grantee: string;
  privilege: string;
  grantable: boolean;
}

/** Compared as a tuple of catalog columns, never as a string built from them. */
export const aclKey = (entry: AclEntry): string =>
  JSON.stringify([
    entry.kind,
    entry.schema,
    entry.name,
    entry.args,
    entry.column,
    entry.objtype,
    entry.owner,
    entry.grantee,
    entry.privilege,
    entry.grantable,
  ]);

/** For a log line: the names come from a database a backup wrote, so they are quoted and cannot forge a line. */
export const describeAcl = (entry: AclEntry): string =>
  JSON.stringify({
    kind: entry.kind,
    object: [entry.schema, entry.name, entry.args, entry.column].filter((part) => part !== ''),
    grantee: entry.grantee,
    privilege: entry.privilege + (entry.grantable ? ' WITH GRANT OPTION' : ''),
  }).slice(0, 240);

/** Every difference between two states of the same database: what appeared, and what went. */
export function aclChanges(before: readonly AclEntry[], after: readonly AclEntry[]): string[] {
  const was = new Set(before.map(aclKey));
  const is = new Set(after.map(aclKey));
  const problems: string[] = [];
  for (const entry of after) {
    if (!was.has(aclKey(entry))) problems.push(`a privilege appeared: ${describeAcl(entry)}`);
  }
  for (const entry of before) {
    if (!is.has(aclKey(entry))) problems.push(`a privilege went: ${describeAcl(entry)}`);
  }
  return problems;
}

/** What `after` has that none of the `allowed` states have. */
export function aclExtras(
  after: readonly AclEntry[],
  ...allowed: readonly (readonly AclEntry[])[]
): string[] {
  const known = new Set(allowed.flatMap((entries) => entries.map(aclKey)));
  return after
    .filter((entry) => !known.has(aclKey(entry)))
    .map((entry) => `a privilege the live database does not have: ${describeAcl(entry)}`);
}

export function quoteIdentifier(name: string): string {
  if (name.includes('\u0000')) throw new Error('an identifier with a NUL');
  return `"${name.replaceAll('"', '""')}"`;
}

const grantee = (name: string) => (name === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(name));

const DEFAULT_OBJECTS: Record<string, string> = {
  r: 'TABLES',
  S: 'SEQUENCES',
  f: 'FUNCTIONS',
  T: 'TYPES',
  n: 'SCHEMAS',
};

/** What a default privilege has before anybody changes it: `ALTER DEFAULT PRIVILEGES` can only take PUBLIC's away from these. */
const BUILT_IN_PUBLIC: Record<string, string> = { f: 'EXECUTE', T: 'USAGE' };

/** What the statements for a restored database say, and where each runs. */
export interface TrustedGrants {
  /** Run in the `postgres` database: the privileges on the database itself. */
  database: string[];
  /** Run inside the restored database. A statement about an object the backup does not have is skipped. */
  inside: string[];
}

function group<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()];
}

const ORDER: AclKind[] = ['schema', 'relation', 'column', 'routine', 'default'];

/**
 * The statements that give database `target` the privileges the live database has. The owner's own privileges are
 * left out (they exist from the start); classes the application does not use (types, languages, foreign servers,
 * large objects) are not re-applied, and a restored database that has any is refused by `aclChanges`.
 */
export function trustedGrants(live: readonly AclEntry[], target: string): TrustedGrants {
  const database: string[] = [];
  const inside: string[] = [];
  const mine = live.filter((entry) => entry.grantee !== entry.owner);

  // An object that has an ACL in the live database has one that PUBLIC may have been taken out of (a function
  // nobody but the runtime role may run, a database only the roles of the application may open). A new object has
  // no ACL, which means PUBLIC has its built-in rights: take them away first, and the grants below put back what
  // the live database has, PUBLIC's included.
  const revoked = new Set<string>();
  for (const entry of live) {
    if (entry.kind === 'database') {
      if (!revoked.has('database')) {
        revoked.add('database');
        database.push(`REVOKE ALL ON DATABASE ${quoteIdentifier(target)} FROM PUBLIC`);
      }
      continue;
    }
    if (!['schema', 'relation', 'routine'].includes(entry.kind)) continue;
    const key = `${entry.kind}|${entry.schema}|${entry.name}|${entry.args}`;
    if (revoked.has(key)) continue;
    revoked.add(key);
    const qualified = `${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.name)}`;
    if (entry.kind === 'schema') {
      inside.push(`REVOKE ALL ON SCHEMA ${quoteIdentifier(entry.name)} FROM PUBLIC`);
    } else if (entry.kind === 'relation') {
      const noun = entry.objtype === 'S' ? 'SEQUENCE' : 'TABLE';
      inside.push(`REVOKE ALL ON ${noun} ${qualified} FROM PUBLIC`);
    } else {
      inside.push(`REVOKE ALL ON ROUTINE ${qualified}(${entry.args}) FROM PUBLIC`);
    }
  }

  for (const entries of group(
    mine.filter((entry) => entry.kind === 'database'),
    (entry) => `${entry.grantee}|${String(entry.grantable)}`,
  )) {
    const first = entries[0];
    if (!first) continue;
    database.push(
      `GRANT ${entries.map((entry) => entry.privilege).join(', ')} ON DATABASE ${quoteIdentifier(target)} TO ${grantee(first.grantee)}${first.grantable ? ' WITH GRANT OPTION' : ''}`,
    );
  }

  for (const kind of ORDER) {
    const ofKind = mine.filter((entry) => entry.kind === kind);
    for (const entries of group(
      ofKind,
      (entry) =>
        `${entry.schema}|${entry.name}|${entry.args}|${entry.column}|${entry.objtype}|${entry.owner}|${entry.grantee}|${String(entry.grantable)}`,
    )) {
      const first = entries[0];
      if (!first) continue;
      const privileges = entries.map((entry) => entry.privilege).join(', ');
      const option = first.grantable ? ' WITH GRANT OPTION' : '';
      const who = grantee(first.grantee);
      const qualified = `${quoteIdentifier(first.schema)}.${quoteIdentifier(first.name)}`;
      if (kind === 'schema') {
        inside.push(
          `GRANT ${privileges} ON SCHEMA ${quoteIdentifier(first.name)} TO ${who}${option}`,
        );
      } else if (kind === 'relation') {
        const noun = first.objtype === 'S' ? 'SEQUENCE' : 'TABLE';
        inside.push(`GRANT ${privileges} ON ${noun} ${qualified} TO ${who}${option}`);
      } else if (kind === 'column') {
        const columns = quoteIdentifier(first.column);
        const withColumn = entries.map((entry) => `${entry.privilege} (${columns})`).join(', ');
        inside.push(`GRANT ${withColumn} ON TABLE ${qualified} TO ${who}${option}`);
      } else if (kind === 'routine') {
        inside.push(
          `GRANT ${privileges} ON ROUTINE ${qualified}(${first.args}) TO ${who}${option}`,
        );
      } else {
        const objects = DEFAULT_OBJECTS[first.objtype];
        if (objects === undefined) continue;
        const where = first.schema === '' ? '' : ` IN SCHEMA ${quoteIdentifier(first.schema)}`;
        inside.push(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(first.owner)}${where} GRANT ${privileges} ON ${objects} TO ${who}${option}`,
        );
      }
    }
  }

  // A default privilege that took PUBLIC's built-in right away (`REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`) is
  // stored as an ACL without PUBLIC in it, so it shows as a row that is missing something: say so.
  for (const entries of group(
    live.filter((entry) => entry.kind === 'default' && entry.schema === ''),
    (entry) => `${entry.owner}|${entry.objtype}`,
  )) {
    const first = entries[0];
    const builtIn = first ? BUILT_IN_PUBLIC[first.objtype] : undefined;
    const objects = first ? DEFAULT_OBJECTS[first.objtype] : undefined;
    if (!first || builtIn === undefined || objects === undefined) continue;
    const hasPublic = entries.some(
      (entry) => entry.grantee === 'PUBLIC' && entry.privilege === builtIn,
    );
    if (!hasPublic) {
      inside.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(first.owner)} REVOKE ${builtIn} ON ${objects} FROM PUBLIC`,
      );
    }
  }
  return { database, inside };
}

/** SQLSTATEs of "that object is not in this database": the statement is about something an older backup lacks. */
export const MISSING_OBJECT_CODES = new Set(['42P01', '42883', '42703', '3F000', '42704']);
