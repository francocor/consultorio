-- Stage 6, judgment day round 3 (JD-S6 R3-3): the alert of a release whose email was lost clears.
--
-- The count of `release_unsent` in `app.platform_health` (0684) took every `released` request with no
-- `emailed_at` older than ten minutes, including the ones the sweep of the releaser will never send
-- (`app.archive_release_unsent`): a link that expired, or a package that was removed. The alert
-- `ArchiveReleaseUnsent` then fired for ever. The count now uses the predicate of the sweep.
--
-- The requests released before `emailed_at` existed (0684, cut on 2026-10-21) have no mark either,
-- and their email did go out at the time: they are marked as emailed at the instant they were
-- released, so they are neither counted nor sent again as a duplicate. The owner of the table needs a
-- policy of its own to update them under FORCE (the pattern of `owner_expire`, 0686), which exists only
-- for the length of this statement.
CREATE POLICY "owner_backfill_emailed" ON "archive_release_request" FOR UPDATE TO CURRENT_USER
  USING ("status" = 'released' AND "emailed_at" IS NULL)
  WITH CHECK ("status" = 'released');
--> statement-breakpoint
UPDATE "archive_release_request"
   SET "emailed_at" = "released_at"
 WHERE "status" = 'released'
   AND "emailed_at" IS NULL
   AND "released_at" < '2026-10-21 22:09:53+00';
--> statement-breakpoint
DROP POLICY "owner_backfill_emailed" ON "archive_release_request";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.platform_health()
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
          AND r.package_removed_at IS NULL AND r.link_expires_at > now()
          AND r.released_at < now() - interval '10 minutes')
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_health() FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_health() TO app_rw;
