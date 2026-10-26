import { describe, expect, it } from 'vitest';

import {
  aclChanges,
  aclExtras,
  aclKey,
  describeAcl,
  quoteIdentifier,
  trustedGrants,
  type AclEntry,
} from './restore-acl.js';

const entry = (overrides: Partial<AclEntry>): AclEntry => ({
  kind: 'relation',
  schema: 'public',
  name: 'patient',
  args: '',
  column: '',
  objtype: 'r',
  owner: 'app_owner',
  grantee: 'app_rw',
  privilege: 'SELECT',
  grantable: false,
  ...overrides,
});

describe('the changes between two states of the privileges of a database', () => {
  it('are nothing when nothing changed, whatever the order', () => {
    const a = entry({});
    const b = entry({ privilege: 'INSERT' });

    expect(aclChanges([a, b], [b, a])).toEqual([]);
  });

  it('name a privilege that appeared and one that went', () => {
    const kept = entry({});
    const appeared = entry({ grantee: 'app_operator' });
    const went = entry({ name: 'visit' });

    const changes = aclChanges([kept, went], [kept, appeared]);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain('appeared');
    expect(changes[0]).toContain('app_operator');
    expect(changes[1]).toContain('went');
  });

  it('are told apart by every column of the catalog, not by how they print', () => {
    // The same words in other columns are other facts: a table called "a|b" is not the table "a" in schema "b".
    expect(aclKey(entry({ schema: 'a', name: 'b|c' }))).not.toBe(
      aclKey(entry({ schema: 'a|b', name: 'c' })),
    );
    expect(aclKey(entry({ grantable: true }))).not.toBe(aclKey(entry({})));
  });

  it('cannot forge a line of the log with the name of an object', () => {
    const text = describeAcl(entry({ name: 'x\nrestore finished' }));

    expect(text).not.toContain('\n');
  });

  it('say what the live database does not have', () => {
    const live = [entry({})];
    const baseline = [entry({ kind: 'schema', name: 'public', schema: '' })];

    const extras = aclExtras([...live, entry({ grantee: 'audit_sealer' })], live, baseline);

    expect(extras).toHaveLength(1);
    expect(extras[0]).toContain('audit_sealer');
  });
});

describe('the grants a restored database is given from the live one', () => {
  it('grants the privileges of a table to each role, together, leaving out the owner', () => {
    const live = [
      entry({ privilege: 'SELECT' }),
      entry({ privilege: 'INSERT' }),
      entry({ grantee: 'app_owner', privilege: 'SELECT' }),
      entry({ grantee: 'audit_sealer', privilege: 'SELECT' }),
    ];

    const { inside } = trustedGrants(live, 'consultorio_restore');

    expect(inside.filter((statement) => statement.startsWith('GRANT'))).toEqual([
      'GRANT SELECT, INSERT ON TABLE "public"."patient" TO "app_rw"',
      'GRANT SELECT ON TABLE "public"."patient" TO "audit_sealer"',
    ]);
  });

  it('uses SEQUENCE for a sequence, a column list for column privileges and ROUTINE for functions', () => {
    const live = [
      entry({ name: 'patient_seq', objtype: 'S', privilege: 'USAGE' }),
      entry({
        kind: 'column',
        name: 'audit_event',
        column: 'seq',
        grantee: 'audit_sealer',
        privilege: 'UPDATE',
      }),
      entry({
        kind: 'routine',
        schema: 'app',
        name: 'set_flags',
        args: 'uuid, text[]',
        objtype: 'f',
        grantee: 'app_rw',
        privilege: 'EXECUTE',
      }),
    ];

    const { inside } = trustedGrants(live, 'x');

    expect(inside).toContain('GRANT USAGE ON SEQUENCE "public"."patient_seq" TO "app_rw"');
    expect(inside).toContain(
      'GRANT UPDATE ("seq") ON TABLE "public"."audit_event" TO "audit_sealer"',
    );
    expect(inside).toContain(
      'GRANT EXECUTE ON ROUTINE "app"."set_flags"(uuid, text[]) TO "app_rw"',
    );
  });

  it('gives the schema and the database their grants, the database one under the name of the restored database', () => {
    const live = [
      entry({ kind: 'schema', schema: '', name: 'app', objtype: '', privilege: 'USAGE' }),
      entry({
        kind: 'database',
        schema: '',
        name: 'consultorio',
        objtype: '',
        grantee: 'app_rw',
        privilege: 'CONNECT',
      }),
    ];

    const grants = trustedGrants(live, 'consultorio_restore');

    expect(grants.inside).toEqual([
      'REVOKE ALL ON SCHEMA "app" FROM PUBLIC',
      'GRANT USAGE ON SCHEMA "app" TO "app_rw"',
    ]);
    expect(grants.database).toEqual([
      'REVOKE ALL ON DATABASE "consultorio_restore" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "consultorio_restore" TO "app_rw"',
    ]);
  });

  it('takes the built-in rights of PUBLIC away from an object before it grants, once, in this order', () => {
    const routine = {
      kind: 'routine',
      schema: 'app',
      name: 'set_flags',
      args: 'uuid',
      objtype: 'f',
    } as const;
    const live = [
      entry({ ...routine, privilege: 'EXECUTE' }),
      entry({ ...routine, grantee: 'app_owner', privilege: 'EXECUTE' }),
    ];

    expect(trustedGrants(live, 'x').inside).toEqual([
      'REVOKE ALL ON ROUTINE "app"."set_flags"(uuid) FROM PUBLIC',
      'GRANT EXECUTE ON ROUTINE "app"."set_flags"(uuid) TO "app_rw"',
    ]);
  });

  it('does that even for an object that only its owner may use', () => {
    const live = [entry({ name: 'secret', grantee: 'app_owner', privilege: 'SELECT' })];

    expect(trustedGrants(live, 'x').inside).toEqual([
      'REVOKE ALL ON TABLE "public"."secret" FROM PUBLIC',
    ]);
  });

  it('carries PUBLIC, grant options and quotes every name', () => {
    const live = [
      entry({ name: 'odd"name', grantee: 'PUBLIC', privilege: 'SELECT', grantable: true }),
    ];

    expect(trustedGrants(live, 'x').inside).toEqual([
      'REVOKE ALL ON TABLE "public"."odd""name" FROM PUBLIC',
      'GRANT SELECT ON TABLE "public"."odd""name" TO PUBLIC WITH GRANT OPTION',
    ]);
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it('re-creates the default privileges of the owner, global and per schema', () => {
    const live = [
      entry({
        kind: 'default',
        schema: 'public',
        name: '',
        objtype: 'r',
        privilege: 'SELECT',
      }),
      entry({
        kind: 'default',
        schema: 'public',
        name: '',
        objtype: 'r',
        privilege: 'INSERT',
      }),
      // `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`: only the owner is left.
      entry({
        kind: 'default',
        schema: '',
        name: '',
        objtype: 'f',
        grantee: 'app_owner',
        privilege: 'EXECUTE',
      }),
    ];

    const { inside } = trustedGrants(live, 'x');

    expect(inside).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "public" GRANT SELECT, INSERT ON TABLES TO "app_rw"',
    );
    expect(inside).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
  });

  it('does not take PUBLIC away when the default privilege still has it', () => {
    const live = [
      entry({
        kind: 'default',
        schema: '',
        name: '',
        objtype: 'f',
        grantee: 'PUBLIC',
        privilege: 'EXECUTE',
      }),
    ];

    expect(trustedGrants(live, 'x').inside.join('\n')).not.toContain('REVOKE');
  });

  it('gives nothing for nothing', () => {
    expect(trustedGrants([], 'x')).toEqual({ database: [], inside: [] });
  });
});
