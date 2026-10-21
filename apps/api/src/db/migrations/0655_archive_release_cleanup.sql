ALTER TABLE "archive_release_request" ADD COLUMN "package_removed_at" timestamp with time zone;--> statement-breakpoint
-- The runtime role records that a package was taken out of the bucket (after the download, or when the
-- link expired). The operator does not touch the delivery.
GRANT UPDATE ("package_removed_at") ON "archive_release_request" TO app_rw;
--> statement-breakpoint
-- The packages that are still in the bucket and should not be: the link expired and nobody downloaded
-- them. Ids and the key of the package, nothing else.
CREATE FUNCTION app.archive_release_cleanup_due(p_limit integer)
  RETURNS TABLE (request_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.target_tenant_id
      FROM public.archive_release_request r
     WHERE r.status = 'released'
       AND r.package_removed_at IS NULL
       AND r.package_key IS NOT NULL
       AND r.link_expires_at <= now()
     ORDER BY r.link_expires_at, r.id
     LIMIT greatest(least(p_limit, 100), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_release_cleanup_due(integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_cleanup_due(integer) TO app_rw;
