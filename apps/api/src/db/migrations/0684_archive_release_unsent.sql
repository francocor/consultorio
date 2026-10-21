-- Stage 6, judgment day round 2 (JD-S6 R2, B-W6): a release whose email was lost is found and sent again.
--
-- The releaser marks the request `released` BEFORE it emails the link (so a link in a mailbox always
-- belongs to a request that says so). A crash between the row and the email, or an undo that failed,
-- left a `released` request whose requester never received anything, and nothing looked for it.
-- `emailed_at` is written once the email went out. The sweep of the releaser lists the released
-- requests with no `emailed_at` after a few minutes (`app.archive_release_unsent`), issues a new link
-- (the token is stored hashed, the old one cannot be sent again) and emails it. The health function
-- counts them for the alert.
ALTER TABLE "archive_release_request" ADD COLUMN "emailed_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE ("emailed_at") ON "archive_release_request" TO app_releaser;
--> statement-breakpoint
CREATE FUNCTION app.archive_release_unsent(p_after_minutes integer, p_limit integer)
  RETURNS TABLE (request_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.target_tenant_id
      FROM public.archive_release_request r
     WHERE r.status = 'released'
       AND r.emailed_at IS NULL
       AND r.package_removed_at IS NULL
       AND r.link_expires_at > now()
       AND r.released_at <= now() - make_interval(mins => greatest(p_after_minutes, 1))
     ORDER BY r.released_at, r.id
     LIMIT greatest(least(p_limit, 100), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_release_unsent(integer, integer) FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_unsent(integer, integer) TO app_releaser;
--> statement-breakpoint
DROP FUNCTION app.platform_health();
--> statement-breakpoint
CREATE FUNCTION app.platform_health()
  RETURNS TABLE (
    archive_verify_corrupted integer,
    archive_verify_missing integer,
    archive_verify_overwritten integer,
    archive_write_failed integer,
    archive_verify_oldest_seconds double precision,
    release_approved_waiting integer,
    release_approved_oldest_seconds double precision,
    releaser_heartbeat_age_seconds double precision,
    signup_unsent integer,
    signup_oldest_unsent_seconds double precision,
    release_unsent integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT
      (SELECT count(*)::integer FROM public.tenant_archive a
        WHERE a.status = 'written' AND a.erased_at IS NULL AND a.verify_status = 'corrupted'),
      (SELECT count(*)::integer FROM public.tenant_archive a
        WHERE a.status = 'written' AND a.erased_at IS NULL AND a.verify_status = 'missing'),
      (SELECT count(*)::integer FROM public.tenant_archive a
        WHERE a.status = 'written' AND a.erased_at IS NULL AND a.verify_status = 'overwritten'),
      (SELECT count(*)::integer FROM public.tenant_archive a WHERE a.status = 'failed'),
      (SELECT coalesce(max(extract(epoch FROM now() - coalesce(a.verified_at, a.archived_at))), 0)::double precision
         FROM public.tenant_archive a WHERE a.status = 'written' AND a.erased_at IS NULL),
      (SELECT count(*)::integer FROM public.archive_release_request r WHERE r.status = 'approved'),
      (SELECT coalesce(max(extract(epoch FROM now() - r.approved_at)), 0)::double precision
         FROM public.archive_release_request r WHERE r.status = 'approved'),
      (SELECT extract(epoch FROM now() - h.beat_at)::double precision
         FROM public.releaser_heartbeat h WHERE h.id = 'releaser'),
      (SELECT count(*)::integer FROM public.signup_pending p
        WHERE p.verified_at IS NULL AND p.verification_sent_at IS NULL
          AND p.created_at < now() - interval '30 minutes'),
      (SELECT coalesce(max(extract(epoch FROM now() - p.created_at)), 0)::double precision
         FROM public.signup_pending p
        WHERE p.verified_at IS NULL AND p.verification_sent_at IS NULL
          AND p.created_at < now() - interval '30 minutes'),
      (SELECT count(*)::integer FROM public.archive_release_request r
        WHERE r.status = 'released' AND r.emailed_at IS NULL
          AND r.released_at < now() - interval '10 minutes')
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_health() FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_health() TO app_rw;
