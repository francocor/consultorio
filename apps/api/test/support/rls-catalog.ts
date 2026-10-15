import type pg from 'pg';

export interface UnprotectedTable {
  schema: string;
  table: string;
  rowSecurity: boolean;
  forced: boolean;
  policies: number;
}

/**
 * Finds tables that carry a `tenant_id` column but are not fully protected: row level security
 * must be enabled AND forced, and at least one policy must exist. Partitions are skipped because
 * queries go through the partitioned parent, which holds the policies.
 */
export async function findUnprotectedTenantTables(
  client: pg.ClientBase,
  schemas: string[],
): Promise<UnprotectedTable[]> {
  const result = await client.query<{
    schema: string;
    table: string;
    row_security: boolean;
    forced: boolean;
    policies: number;
  }>(
    `SELECT n.nspname AS schema,
            c.relname AS "table",
            c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND n.nspname = ANY($1)
      ORDER BY 1, 2`,
    [schemas],
  );

  return result.rows
    .filter((row) => !(row.row_security && row.forced && row.policies > 0))
    .map((row) => ({
      schema: row.schema,
      table: row.table,
      rowSecurity: row.row_security,
      forced: row.forced,
      policies: row.policies,
    }));
}
