-- The search path of a SECURITY DEFINER function must end with pg_temp (Stage 1 security review,
-- finding 4, hardening).
--
-- PostgreSQL searches the session's temporary schema FIRST for relations and types unless
-- `pg_temp` appears in the path. Every role that can connect may create temporary tables, so a
-- caller could create `pg_temp.membership` and make a function that runs with the owner's rights
-- read it instead of the real table. Naming pg_temp last turns that off. Each function keeps the
-- schemas it already had, with pg_catalog first.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature,
           EXISTS (
             SELECT 1 FROM unnest(p.proconfig) AS option
              WHERE option LIKE 'search_path=%' AND option LIKE '%public%'
           ) AS uses_public
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = %s',
      fn.signature,
      CASE WHEN fn.uses_public THEN 'pg_catalog, public, pg_temp' ELSE 'pg_catalog, pg_temp' END
    );
  END LOOP;
END
$$;
