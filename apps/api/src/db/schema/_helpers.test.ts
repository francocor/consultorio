import { getTableConfig, text, unique } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { clinicalPolicies, tenantPolicies, tenantTable } from './_helpers.js';

describe('tenantTable', () => {
  const widget = tenantTable('widget', { label: text('label').notNull() });
  const config = getTableConfig(widget);

  it('adds a UUIDv7 primary key, the tenant column and timestamps next to the given columns', () => {
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(Object.keys(columns).sort()).toEqual([
      'created_at',
      'id',
      'label',
      'tenant_id',
      'updated_at',
    ]);
    expect(columns['id']).toMatchObject({ primary: true, notNull: true, columnType: 'PgUUID' });
    expect(columns['id']?.default).toBeDefined();
    expect(columns['tenant_id']).toMatchObject({ notNull: true, columnType: 'PgUUID' });
    expect(columns['created_at']).toMatchObject({ notNull: true });
    expect(columns['updated_at']).toMatchObject({ notNull: true });
  });

  it('declares UNIQUE (tenant_id, id) so other tables can reference it with a composite key', () => {
    const unique = config.uniqueConstraints.find(
      (constraint) => constraint.name === 'widget_tenant_id_id_key',
    );

    expect(unique?.columns.map((column) => column.name)).toEqual(['tenant_id', 'id']);
  });

  it('keeps extra table config, such as a second constraint, next to the tenant unique', () => {
    const table = tenantTable('gadget', { code: text('code').notNull() }, (t) => [
      // Shape only: the helper must forward the callback result.
      unique('gadget_code_key').on(t.tenantId, t.code),
    ]);

    expect(
      getTableConfig(table)
        .uniqueConstraints.map((constraint) => constraint.name)
        .sort(),
    ).toEqual(['gadget_code_key', 'gadget_tenant_id_id_key']);
  });
});

describe('tenantPolicies', () => {
  it('generates ENABLE, FORCE and the tenant_isolation policy (snapshot)', () => {
    expect(tenantPolicies('location')).toMatchInlineSnapshot(`
      "ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;
      --> statement-breakpoint
      ALTER TABLE "location" FORCE ROW LEVEL SECURITY;
      --> statement-breakpoint
      CREATE POLICY "tenant_isolation" ON "location" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);"
    `);
  });

  it('can target a different column, as the tenant table does with its own id', () => {
    expect(tenantPolicies('tenant', { column: 'id' })).toContain(
      `USING ("id" = current_setting('app.tenant_id')::uuid)`,
    );
  });

  it('quotes the table name', () => {
    expect(tenantPolicies('weird"name')).toContain('"weird""name"');
  });
});

describe('clinicalPolicies', () => {
  const statements = (sql: string) => sql.split('\n--> statement-breakpoint\n');

  it('creates the two RESTRICTIVE policies of the clinical backstop (ADR-003)', () => {
    const [professionalsOnly, scope] = statements(clinicalPolicies('clinical_note'));

    expect(professionalsOnly).toBe(
      'CREATE POLICY "clinical_professionals_only" ON "clinical_note" AS RESTRICTIVE USING (nullif(current_setting(\'app.professional_id\', true), \'\') IS NOT NULL);',
    );
    expect(scope).toBe(
      'CREATE POLICY "clinical_scope" ON "clinical_note" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", "template_kind"));',
    );
  });

  it('adapts to the column names of the table', () => {
    const [, scope] = statements(
      clinicalPolicies('anamnesis', {
        authorColumn: 'recorded_by_professional_id',
        templateKind: null,
      }),
    );

    expect(scope).toContain(
      'app.clinical_readable("patient_id", "recorded_by_professional_id", "visibility", NULL::text)',
    );
  });

  it('takes a constant template kind, as prescriptions do, which never follow sharing', () => {
    const [, scope] = statements(
      clinicalPolicies('prescription', { templateKind: { constant: 'prescription' } }),
    );

    expect(scope).toContain('"visibility", \'prescription\'::text)');
  });

  it('quotes identifiers and escapes the constant', () => {
    const [first, scope] = statements(
      clinicalPolicies('weird"name', { templateKind: { constant: "it's" } }),
    );

    expect(first).toContain('"weird""name"');
    expect(scope).toContain("'it''s'::text");
  });
});
