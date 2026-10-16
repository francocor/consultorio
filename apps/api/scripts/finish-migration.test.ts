import { describe, expect, it } from 'vitest';

import { finishMigration } from './finish-migration.js';

const GENERATED = `CREATE TABLE "tenant_key" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "tenant_key_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "other_table" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_key" ADD CONSTRAINT "tenant_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_table" ADD CONSTRAINT "other_table_parent_fkey" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."parent"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_key_one_active_idx" ON "tenant_key" USING btree ("tenant_id");`;

describe('finishMigration', () => {
  const result = finishMigration(GENERATED, ['tenant_key']);

  it('moves the foreign key to the tenant table into CREATE TABLE', () => {
    expect(result).toContain(
      `CONSTRAINT "tenant_key_tenant_id_id_key" UNIQUE("tenant_id","id"),\n\tCONSTRAINT "tenant_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")\n);`,
    );
    expect(result).not.toContain(
      'ALTER TABLE "tenant_key" ADD CONSTRAINT "tenant_key_tenant_id_fkey"',
    );
  });

  it('leaves other foreign keys, other tables and the rest of the file alone', () => {
    expect(result).toContain('ALTER TABLE "other_table" ADD CONSTRAINT "other_table_parent_fkey"');
    expect(result).toContain('CREATE UNIQUE INDEX "tenant_key_one_active_idx"');
    expect(result).toContain(
      'CREATE TABLE "other_table" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"tenant_id" uuid NOT NULL\n);',
    );
  });

  it('keeps statement separators valid after removing the ALTER statement', () => {
    expect(result).not.toMatch(/;--> statement-breakpoint\n--> statement-breakpoint/);
    expect(result).not.toMatch(/--> statement-breakpoint\n--> statement-breakpoint/);
  });

  it('appends enable, force and the tenant_isolation policy for each listed table', () => {
    expect(result).toContain('ALTER TABLE "tenant_key" ENABLE ROW LEVEL SECURITY;');
    expect(result).toContain('ALTER TABLE "tenant_key" FORCE ROW LEVEL SECURITY;');
    expect(result).toContain('CREATE POLICY "tenant_isolation" ON "tenant_key"');
    expect(result).not.toContain('ALTER TABLE "other_table" ENABLE ROW LEVEL SECURITY');
  });

  it('protects several tables at once', () => {
    const both = finishMigration(GENERATED, ['tenant_key', 'other_table']);

    expect(both).toContain('CREATE POLICY "tenant_isolation" ON "other_table"');
  });

  it('refuses a table that the migration does not create', () => {
    expect(() => finishMigration(GENERATED, ['missing_table'])).toThrow(/missing_table/);
  });
});
