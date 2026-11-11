-- Stage 6, judgment day round 1 (signup and retention): erasure state, a guard for written archives,
-- and the platform-wide health figures the alert rules read.
--
-- JD-S6 R1-S6-7, legal erasure. An erasure removes objects from the archive bucket; until now nothing in
-- the database said so, and `archive.verify` would report an erased archive as `missing`. The prefixes
-- erased are persisted on the archive row (`erased_prefixes`, and `erased_at` when the whole archive
-- went), written by the erasure command through a definer function (the operator role has no privilege
-- on the table). Verification skips what was erased, the release answers `erased`, and the operator
-- cannot record a release for an archive that is gone.
--
-- A written archive is immutable. The worker writes the manifest once, while the archive is `pending`
-- (`markArchiveWritten`); after that no application role may change what the archive IS (its
-- manifest, counts, retention or status), only record verifications. A compromised worker could
-- otherwise point a written archive at a manifest of its own.
--
-- JD-S6 R1-S6-5, alerts. `app.platform_health()` answers, across every organization and in one call,
-- the figures the collector cannot read organization by organization (the archives of cancelled
-- organizations, the release requests, the signups nobody confirmed) and the age of the last
-- heartbeat of the releaser. Counts and ages only.
--
-- JD-S6 R1-A-W7, the plaintext export. The packages of the cancellation export sit in the bucket of the
-- organization as plain zips. They are kept for the download window and for as long as the archive that
-- replaces them has not been verified, whichever is later; then the worker removes the object
-- (`object_removed_at`) and writes the entry of the organization's trail. `app.export_cleanup_due` lists
-- the organizations that reached that point, ids only.

-- 1. The erasure state.
ALTER TABLE "tenant_archive" ADD COLUMN "erased_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenant_archive" ADD COLUMN "erased_prefixes" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_archive" ADD CONSTRAINT "tenant_archive_erased_check" CHECK ("tenant_archive"."erased_at" is null or cardinality("tenant_archive"."erased_prefixes") >= 1);
--> statement-breakpoint
-- Records that a folder of the archive of the organization of the transaction was erased. Only the
-- erasure command (the operator role) calls it, after it wrote the intent in the platform trail. The
-- prefix must be inside the archive of the organization; the whole folder sets `erased_at`.
CREATE FUNCTION app.archive_mark_erased(p_tenant uuid, p_prefix text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_root text := 'tenants/' || p_tenant::text || '/';
    v_rows integer;
  BEGIN
    IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
      RAISE EXCEPTION 'the erasure is recorded for the organization of the transaction only'
        USING ERRCODE = '42501';
    END IF;
    IF p_prefix IS NULL OR left(p_prefix, length(v_root)) <> v_root THEN
      RAISE EXCEPTION 'the prefix is not inside the archive of the organization' USING ERRCODE = '42501';
    END IF;
    UPDATE public.tenant_archive a
       SET erased_prefixes = CASE
             WHEN p_prefix = ANY (a.erased_prefixes) THEN a.erased_prefixes
             ELSE array_append(a.erased_prefixes, p_prefix) END,
           erased_at = CASE WHEN p_prefix = v_root THEN coalesce(a.erased_at, now()) ELSE a.erased_at END,
           updated_at = now()
     WHERE a.tenant_id = p_tenant;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_mark_erased(uuid, text) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_mark_erased(uuid, text) TO app_operator;
--> statement-breakpoint
-- An archive that was erased is no longer "written" for the one question the operator may ask.
CREATE OR REPLACE FUNCTION app.archive_is_written(p_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.tenant_archive a
       WHERE a.tenant_id = p_tenant AND a.status = 'written' AND a.erased_at IS NULL
    )
  $$;
--> statement-breakpoint
-- And is not verified again.
CREATE OR REPLACE FUNCTION app.archive_verify_due(p_every_days integer, p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.tenant_id
      FROM public.tenant_archive a
     WHERE a.status = 'written'
       AND a.erased_at IS NULL
       AND (a.verified_at IS NULL OR a.verified_at <= now() - make_interval(days => greatest(p_every_days, 0)))
     ORDER BY a.verified_at NULLS FIRST, a.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
--> statement-breakpoint
-- 2. A written archive does not change what it is.
CREATE FUNCTION app.tenant_archive_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF current_user IN ('app_rw', 'app_operator', 'app_releaser') AND OLD.status = 'written' AND (
         NEW.status IS DISTINCT FROM OLD.status
      OR NEW.manifest_key IS DISTINCT FROM OLD.manifest_key
      OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
      OR NEW.objects_count IS DISTINCT FROM OLD.objects_count
      OR NEW.bytes_total IS DISTINCT FROM OLD.bytes_total
      OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
      OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
      OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
    ) THEN
      RAISE EXCEPTION 'a written archive cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER tenant_archive_guard
  BEFORE UPDATE ON "tenant_archive"
  FOR EACH ROW EXECUTE FUNCTION app.tenant_archive_guard();
--> statement-breakpoint
-- 3. The heartbeat of the releaser: one row, written by the releaser through a function.
CREATE TABLE "releaser_heartbeat" (
	"id" text PRIMARY KEY DEFAULT 'releaser' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "releaser_heartbeat_id_check" CHECK ("releaser_heartbeat"."id" = 'releaser')
);
--> statement-breakpoint
-- Nobody touches the table directly: the releaser writes through `app.releaser_beat` (granted in
-- 0688) and the health function reads it.
REVOKE ALL ON "releaser_heartbeat" FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
CREATE FUNCTION app.releaser_beat(p_started_at timestamp with time zone) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    INSERT INTO public.releaser_heartbeat (id, started_at, beat_at)
    VALUES ('releaser', p_started_at, now())
    ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, beat_at = excluded.beat_at
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.releaser_beat(timestamp with time zone) FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
-- 4. The figures the alert rules read.
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
    signup_oldest_unsent_seconds double precision
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
          AND p.created_at < now() - interval '30 minutes')
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_health() FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_health() TO app_rw;
--> statement-breakpoint
-- 5. The plaintext export is removed once the archive that replaces it is written and verified.
ALTER TABLE "export_package" ADD COLUMN "object_removed_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE ("object_removed_at") ON "export_package" TO app_rw;
--> statement-breakpoint
CREATE FUNCTION app.export_cleanup_due(p_after_days integer, p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT e.tenant_id
      FROM public.export_package e
      JOIN public.tenant_archive a ON a.tenant_id = e.tenant_id
     WHERE e.status = 'ready'
       AND e.object_removed_at IS NULL
       AND a.status = 'written'
       AND a.erased_at IS NULL
       AND a.verify_status = 'ok'
       AND a.verified_at IS NOT NULL
       -- The download window counts from the request of the export (the cancellation).
       AND EXISTS (
         SELECT 1 FROM public.export_package r
          WHERE r.tenant_id = e.tenant_id AND r.kind = 'administrative'
            AND r.created_at <= now() - make_interval(days => greatest(p_after_days, 0))
       )
     ORDER BY e.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.export_cleanup_due(integer, integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.export_cleanup_due(integer, integer) TO app_rw;
