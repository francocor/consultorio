-- Stage 6, judgment day round 1 (signup and retention): the break-glass release, hardened.
--
-- JD-S6 R1-S6-4, four eyes. The person who approved a release is neither the one who verified the
-- identity (0654) nor the one who recorded the request (new check). Each step is also bound to the
-- operator who takes it: the application sets `app.user_id` to the operator of the session, and the
-- trigger below refuses an update whose `identity_verified_by`, `approved_by` or `rejected_by` is
-- anybody else, so a bug (or a compromised console) cannot put another operator's name on a step.
-- A request that waited more than seven days in `requested` or `identity_verified` is closed by the
-- releaser's sweep (`app.archive_release_expire_stale`, granted in 0688) and cannot be approved late.
--
-- JD-S6 R1-S6-8, delivery. The download is counted when the transfer ENDS, not when it starts: the
-- API takes a short lease on the request (`download_started_at`, at most five attempts in the life of
-- the link), so an aborted download can be retried within the link's life and two downloads cannot
-- run at once. A failed or expired release leaves no package: the cleanup function now lists those
-- rows too. A release whose email could not be sent goes from `released` to `failed`, which only the
-- releaser may do.

-- 1. Four eyes: the approver is not the person who recorded the request.
ALTER TABLE "archive_release_request" ADD CONSTRAINT "archive_release_request_recorder_check" CHECK ("archive_release_request"."approved_by" is null or "archive_release_request"."approved_by" <> "archive_release_request"."recorded_by") NOT VALID;
--> statement-breakpoint
-- 2. The lease of a download.
ALTER TABLE "archive_release_request" ADD COLUMN "download_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "archive_release_request" ADD COLUMN "download_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "archive_release_request" ADD CONSTRAINT "archive_release_request_attempts_check" CHECK ("archive_release_request"."download_attempts" >= 0);
--> statement-breakpoint
GRANT UPDATE ("download_started_at", "download_attempts") ON "archive_release_request" TO app_rw;
--> statement-breakpoint
-- 3. The steps of a request, by the role that owns each one, and by the operator who takes them.
--   operator:  requested -> identity_verified -> approved, and open -> rejected, each with the
--              operator of the session on the step, and none of the first two after seven days
--   releaser:  approved -> released | expired | failed, and released -> failed (the email did not go)
-- Anything else is refused. The owner (a migration, a definer function) is not bound.
CREATE OR REPLACE FUNCTION app.archive_release_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  BEGIN
    IF NEW.status = OLD.status OR current_user NOT IN ('app_operator', 'app_rw', 'app_releaser') THEN
      RETURN NEW;
    END IF;
    IF current_user = 'app_operator' AND v_actor IS NOT NULL THEN
      IF OLD.status = 'requested' AND NEW.status = 'identity_verified'
         AND NEW.identity_verified_by = v_actor
         AND OLD.created_at > now() - interval '7 days' THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'identity_verified' AND NEW.status = 'approved'
         AND NEW.approved_by = v_actor
         AND OLD.created_at > now() - interval '7 days' THEN
        RETURN NEW;
      END IF;
      IF OLD.status IN ('requested', 'identity_verified', 'approved') AND NEW.status = 'rejected'
         AND NEW.rejected_by = v_actor THEN
        RETURN NEW;
      END IF;
    END IF;
    IF current_user = 'app_releaser' AND (
         (OLD.status = 'approved' AND NEW.status IN ('released', 'expired', 'failed'))
      OR (OLD.status = 'released' AND NEW.status = 'failed')
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a release request cannot go from % to % for this role', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
-- 4. The sweep that closes the requests nobody carried on for seven days. The owner needs a policy of
-- its own to update them under FORCE (the pattern of `owner_lookup`); the runtime roles get nothing.
CREATE POLICY "owner_expire" ON "archive_release_request" FOR UPDATE TO CURRENT_USER
  USING ("status" IN ('requested', 'identity_verified'))
  WITH CHECK ("status" = 'expired');
--> statement-breakpoint
CREATE FUNCTION app.archive_release_expire_stale(p_open_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_row record;
    v_count integer := 0;
  BEGIN
    FOR v_row IN
      SELECT r.id, r.target_tenant_id, r.status
        FROM public.archive_release_request r
       WHERE r.status IN ('requested', 'identity_verified')
         AND r.created_at <= now() - make_interval(days => greatest(p_open_days, 1))
       ORDER BY r.created_at, r.id
       LIMIT 100
         FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.archive_release_request
         SET status = 'expired', updated_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.platform_audit_event
        (operator_id, target_tenant_id, action, outcome, resource_type, resource_id, metadata)
      VALUES
        (NULL, v_row.target_tenant_id, 'archive.released', 'allow', 'archive_release_request',
         v_row.id, jsonb_build_object('phase', 'expired', 'from', v_row.status));
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_release_expire_stale(integer) FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
-- 5. The packages that are still in the bucket and should not be: the link of a released one expired,
-- or a release that failed or expired left one behind. Ids only (the key is derived from the id).
CREATE OR REPLACE FUNCTION app.archive_release_cleanup_due(p_limit integer)
  RETURNS TABLE (request_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.target_tenant_id
      FROM public.archive_release_request r
     WHERE r.package_removed_at IS NULL
       AND (
            (r.status = 'released' AND r.package_key IS NOT NULL AND r.link_expires_at <= now())
         OR (r.status IN ('failed', 'expired') AND r.updated_at <= now() - interval '10 minutes')
       )
     ORDER BY r.updated_at, r.id
     LIMIT greatest(least(p_limit, 100), 1)
  $$;
