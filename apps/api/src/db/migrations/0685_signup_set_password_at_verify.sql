-- Stage 6, judgment day round 1 (signup and retention), JD-S6 R1-S6-3 and R1-A-T5.
--
-- 1. The pending signup keeps no password and no acceptance. Whoever types an address on the public
--    form has not proved it is theirs: a password hash stored at signup was a stranger's choice, and
--    the verification used it to create the account of the person who followed the link (a pre-hijack
--    of the victim's account). The owner now sets the password and accepts the terms on the page of
--    the link, and the verification records both. The columns go with the check that tied the hash to
--    the verification: Stage 6 is not deployed, so no row holds anything worth keeping, and a hash
--    that is never written has no business staying in the table.
-- 2. The purge counts the organizations it could not remove (`purge_attempts`) and works the ones with
--    fewer failures first, so rows that fail with a foreign key violation do not starve the newer
--    rows behind them. The function is the one of 0640 with that and nothing else changed.
-- 3. `tenant_status_check` (0640) was left NOT VALID: it is validated here as well. `runMigrations`
--    validates every constraint left NOT VALID after the migrator; this makes the migration itself
--    leave it validated. The `tenant` table is small, and on a database that already ran 0640 this is
--    a separate run, so the lock of 0640's ADD CONSTRAINT is long gone.
ALTER TABLE "signup_pending" DROP CONSTRAINT "signup_pending_hash_check";
--> statement-breakpoint
ALTER TABLE "signup_pending" DROP COLUMN "password_hash";
--> statement-breakpoint
ALTER TABLE "signup_pending" DROP COLUMN "terms_version";
--> statement-breakpoint
ALTER TABLE "signup_pending" DROP COLUMN "data_processing_version";
--> statement-breakpoint
ALTER TABLE "signup_pending" DROP COLUMN "accepted_at";
--> statement-breakpoint
ALTER TABLE "signup_pending" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "signup_pending" ADD CONSTRAINT "signup_pending_purge_attempts_check" CHECK ("signup_pending"."purge_attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "tenant" VALIDATE CONSTRAINT "tenant_status_check";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.signup_purge(p_older_than timestamp with time zone, p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cutoff timestamp with time zone := LEAST(p_older_than, now() - interval '1 day');
  v_ids uuid[];
  v_id uuid;
  v_age integer;
  v_purged integer := 0;
BEGIN
  -- Listing the candidates is a platform scan of the organizations table (policy tenant_platform_scan).
  PERFORM set_config('app.scope', 'platform', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
  -- The ones that failed before go last, so a row that never goes does not keep the others waiting.
  SELECT coalesce(array_agg(c.id ORDER BY c.attempts, c.created_at), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT t.id, t.created_at, coalesce(p.purge_attempts, 0) AS attempts
        FROM public.tenant t
        LEFT JOIN public.signup_pending p ON p.tenant_id = t.id
       WHERE t.status = 'unverified' AND t.created_at < v_cutoff
       ORDER BY coalesce(p.purge_attempts, 0), t.created_at
       LIMIT greatest(least(p_limit, 500), 0)
    ) c;

  FOREACH v_id IN ARRAY v_ids LOOP
    BEGIN
      PERFORM set_config('app.tenant_id', v_id::text, true);
      PERFORM set_config('app.signup_purge', v_id::text, true);
      SELECT floor(extract(epoch FROM now() - t.created_at) / 86400)::integer INTO v_age
        FROM public.tenant t WHERE t.id = v_id AND t.status = 'unverified';
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      DELETE FROM public.signup_pending WHERE tenant_id = v_id;
      DELETE FROM public.action_token WHERE tenant_id = v_id;
      DELETE FROM public.job_execution WHERE tenant_id = v_id;
      DELETE FROM public.audit_event WHERE tenant_id = v_id;
      DELETE FROM public.tenant WHERE id = v_id AND status = 'unverified';
      INSERT INTO public.platform_audit_event
        (operator_id, target_tenant_id, action, outcome, resource_type, resource_id, metadata)
      VALUES
        (NULL, v_id, 'signup.purged', 'allow', 'tenant', v_id, jsonb_build_object('ageDays', v_age));
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- Something else points at it: it is not a bare signup, so it stays. The block was rolled back
      -- (the organization context with it), so the failure is counted under that context again.
      PERFORM set_config('app.tenant_id', v_id::text, true);
      UPDATE public.signup_pending SET purge_attempts = purge_attempts + 1 WHERE tenant_id = v_id;
    END;
  END LOOP;

  PERFORM set_config('app.signup_purge', '', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
  RETURN v_purged;
END
$$;
