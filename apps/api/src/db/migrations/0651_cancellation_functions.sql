-- Stage 6, track C (retention): the two functions the cancellation export needs and that the roles
-- of the application cannot do by themselves.
--
-- 1. app.operator_cancel_tenant: the operator console cancels an organization (task 6.36, for
--    single-tenant deployments and local testing). The operator role cannot update the tenant row
--    (migration 0017: "nothing is updatable"), so the one change it may make is a function that does
--    exactly that: active or read-only to cancelled, never a demo organization, never twice. The
--    organization is the one of the transaction (`app.tenant_id`), which row level security enforces
--    for the owner of the function too.
-- 2. app.cancellation_export_pending: which organizations have a package waiting to be built. The
--    cancellation is announced inside the transaction that cancelled, and that transaction may be the
--    operator's, which has no privilege on the job queue; so the announcement is a row
--    (`export_package`, queued) and the worker looks for those rows. The function returns tenant ids
--    and nothing else.
CREATE FUNCTION app.operator_cancel_tenant(p_tenant uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_status text;
    v_demo boolean;
  BEGIN
    SELECT t.status, t.is_demo INTO v_status, v_demo
      FROM public.tenant t
     WHERE t.id = p_tenant
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'unknown';
    END IF;
    IF v_demo THEN
      RETURN 'demo';
    END IF;
    IF v_status = 'cancelled' THEN
      RETURN 'already';
    END IF;
    IF v_status NOT IN ('active', 'read_only') THEN
      RETURN 'not_cancellable';
    END IF;
    UPDATE public.tenant SET status = 'cancelled', updated_at = now() WHERE id = p_tenant;
    RETURN 'cancelled';
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_cancel_tenant(uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_cancel_tenant(uuid) TO app_operator;
--> statement-breakpoint
-- The owner of the tables needs a read-only policy of its own to see across organizations under
-- FORCE row level security (the pattern of migration 0392). The runtime role gets nothing new.
CREATE POLICY "export_package_owner_lookup" ON "export_package" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE FUNCTION app.cancellation_export_pending(p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT p.tenant_id
      FROM public.export_package p
     WHERE p.status = 'queued'
     ORDER BY p.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.cancellation_export_pending(integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.cancellation_export_pending(integer) TO app_rw;
