import { tenantPolicies } from '../src/db/schema/_helpers.js';

/**
 * Prints the row level security SQL for one or more tenant tables, to paste at the end of the
 * migration that creates them:
 *
 *   pnpm --filter @consultorio/api exec tsx scripts/tenant-policies.ts location tenant_feature
 *
 * Pass `table:column` for a table that is isolated by a column other than `tenant_id`.
 */
const statements = process.argv.slice(2).map((argument) => {
  const [table = '', column] = argument.split(':');
  return tenantPolicies(table, column ? { column } : {});
});

process.stdout.write(`${statements.join('\n--> statement-breakpoint\n')}\n`);
