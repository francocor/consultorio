import type pg from 'pg';

export interface DefinerFunction {
  /** `app.name(argument types)`. */
  signature: string;
  /** The `SET` options of the function, such as `search_path=pg_catalog, public`. */
  config: string[];
  /** True when the `PUBLIC` pseudo-role may execute it. */
  publicExecute: boolean;
  /** The roles (of those asked about) that can execute it, directly or through PUBLIC or membership. */
  executableBy: string[];
}

/**
 * Every SECURITY DEFINER function of a schema (extension members excluded) with who can run it.
 * A definer function runs with its owner's rights, so who may call it is part of the security
 * model and must be a decision, not an accident of default privileges.
 */
export async function listDefinerFunctions(
  client: pg.ClientBase,
  schema: string,
  roles: readonly string[],
): Promise<DefinerFunction[]> {
  const result = await client.query<{
    signature: string;
    config: string[] | null;
    public_execute: boolean;
    executable_by: string[];
  }>(
    `SELECT p.oid::regprocedure::text AS signature,
            p.proconfig AS config,
            coalesce((SELECT bool_or(a.grantee = 0)
                        FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a), false)
              AS public_execute,
            ARRAY(SELECT r FROM unnest($2::text[]) AS r
                   WHERE has_function_privilege(r, p.oid, 'EXECUTE')
                   ORDER BY r) AS executable_by
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
        AND p.prokind = 'f'
        AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
    [schema, [...roles]],
  );
  return result.rows.map((row) => ({
    signature: row.signature,
    config: row.config ?? [],
    publicExecute: row.public_execute,
    executableBy: row.executable_by,
  }));
}

/**
 * True when the function pins a search path that starts with `pg_catalog` (so nobody can shadow a
 * built-in) and ends with `pg_temp` (so the session's temporary schema, which PostgreSQL searches
 * FIRST for relations unless it is named, cannot shadow a table the function reads).
 */
export function pinsSearchPath(config: readonly string[]): boolean {
  const entry = config.find((option) => option.startsWith('search_path='));
  if (entry === undefined) return false;
  const schemas = entry
    .slice('search_path='.length)
    .split(',')
    .map((schema) => schema.trim());
  return schemas[0] === 'pg_catalog' && schemas[schemas.length - 1] === 'pg_temp';
}
