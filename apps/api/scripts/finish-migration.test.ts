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

  describe('composite foreign keys', () => {
    const SOURCE = `CREATE TABLE "child" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "child" ADD CONSTRAINT "child_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child" ADD CONSTRAINT "child_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child" ADD CONSTRAINT "child_parent_fkey" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."parent"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "child_idx" ON "child" USING btree ("tenant_id");`;
    const both = finishMigration(SOURCE, ['child', 'parent']);

    it('moves a key to a table that already exists into CREATE TABLE, with its columns', () => {
      expect(both).toContain(
        `CONSTRAINT "child_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id")`,
      );
      expect(both).not.toContain('ALTER TABLE "child" ADD CONSTRAINT "child_membership_fkey"');
      expect(both).toMatch(
        /CREATE TABLE "child" \([\s\S]*child_tenant_id_fkey[\s\S]*child_membership_fkey[\s\S]*\);/,
      );
    });

    it('keeps a key between two tables of the same migration as ALTER TABLE', () => {
      expect(both).toContain(
        'ALTER TABLE "child" ADD CONSTRAINT "child_parent_fkey" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."parent"("tenant_id","id")',
      );
    });

    it('runs the ALTER TABLE of an in-migration key before row level security is forced', () => {
      const alter = both.indexOf('ADD CONSTRAINT "child_parent_fkey"');
      const force = both.indexOf('ALTER TABLE "parent" FORCE ROW LEVEL SECURITY');

      expect(alter).toBeGreaterThan(-1);
      expect(alter).toBeLessThan(force);
    });
  });

  it('refuses a table that the migration does not create', () => {
    expect(() => finishMigration(GENERATED, ['missing_table'])).toThrow(/missing_table/);
  });
});
