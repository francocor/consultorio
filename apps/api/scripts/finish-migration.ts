import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tenantPolicies } from '../src/db/schema/_helpers.js';

const BREAKPOINT = '--> statement-breakpoint';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Completes a migration that drizzle-kit generated for new tenant tables:
 *
 * 1. Moves each `ALTER TABLE x ADD CONSTRAINT ... FOREIGN KEY ("tenant_id") REFERENCES tenant`
 *    into the `CREATE TABLE`. The `tenant` table has FORCE row level security, so validating
 *    that foreign key afterwards needs a tenant context a migration does not have; a foreign key
 *    declared inline skips the validation scan.
 * 2. Appends ENABLE, FORCE and the `tenant_isolation` policy for every listed table.
 */
export function finishMigration(sql: string, tables: readonly string[]): string {
  let result = sql;

  for (const table of tables) {
    const create = new RegExp(`CREATE TABLE "${escapeRegExp(table)}" \\(\\n([\\s\\S]*?)\\n\\);`);
    if (!create.test(result)) {
      throw new Error(`Table "${table}" is not created by this migration`);
    }

    const alter = new RegExp(
      `ALTER TABLE "${escapeRegExp(table)}" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \\("tenant_id"\\) REFERENCES "public"\\."tenant"\\("id"\\)[^;]*;(?:${escapeRegExp(BREAKPOINT)})?\\n?`,
    );
    const match = alter.exec(result);
    if (!match) continue;
    const name = match[1] ?? '';

    result = result.replace(alter, '');
    result = result.replace(
      create,
      (_whole, body: string) =>
        `CREATE TABLE "${table}" (\n${body},\n\tCONSTRAINT "${name}" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")\n);`,
    );
  }

  // Dropping an ALTER that was the last statement may leave a dangling separator.
  result = result.replace(/(?:--> statement-breakpoint\n){2,}/g, `${BREAKPOINT}\n`).trimEnd();

  const policies = tables.map((table) => tenantPolicies(table));
  return `${result}\n${BREAKPOINT}\n${policies.join(`\n${BREAKPOINT}\n`)}\n`;
}

/**
 * pnpm --filter @consultorio/api exec tsx scripts/finish-migration.ts <migration.sql> <table>...
 */
function main(): void {
  const [file, ...tables] = process.argv.slice(2);
  if (!file || tables.length === 0) {
    process.stderr.write('Usage: finish-migration.ts <migration.sql> <table>...\n');
    process.exit(1);
  }
  const path = resolve(file);
  writeFileSync(path, finishMigration(readFileSync(path, 'utf8'), tables));
  process.stdout.write(`Finished ${path}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
