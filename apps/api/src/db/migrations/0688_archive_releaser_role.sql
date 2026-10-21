-- Stage 6, judgment day round 1 (signup and retention), JD-S6 R1-S6-12: the releaser has a database
-- role of its own.
--
-- Until now the API, the worker and the releaser connected as the same role (`app_rw`), so whoever
-- held the credential of the API held the power of the releaser over the delivery of an archive: to
-- mark a request `released` and set the package it points at, to write the audit entries that say a
-- release was decrypted and delivered, and to see which requests wait for it. The releaser is the one
-- process that decrypts the archive; the database now agrees.
--
-- `app_releaser` is a member of `app_rw` (created by `infra/postgres/init/01-roles.sql`, or by the
-- infrastructure in production: this migration refuses to run without it), so it keeps everything the
-- releaser used (its queue, its tokens, its reads) and ADDS what is taken away from `app_rw` here:
--
--   * the columns of the delivery of `archive_release_request` (`status`, `released_at`,
--     `package_key`, `package_sha256`, `package_bytes`, `link_expires_at`, `failure_code`). The API
--     keeps `downloaded_at`, `package_removed_at` and the lease of the download, which are the
--     requester's side;
--   * the functions that tell the releaser what to carry out (`archive_release_due`,
--     `archive_release_cleanup_due`, `archive_release_expire_stale`) and its heartbeat;
--   * the audit entries of the release (`archive.accessed`, `archive.released`: decrypted, delivered,
--     failed, expired). The worker keeps `archive.written` and `archive.verified`, and the API gets one
--     narrow function that writes the entry of a download of a request that was released.
--
-- What is left (documented in docs/runbooks/archive-release.md): the API and the worker still share
-- `app_rw` between them, and `archive_key.wrapped_private_key` is readable by `app_rw` (it is opaque
-- without `ARCHIVE_RELEASER_KEK`, and the writer needs the table to insert the key).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_releaser') THEN
    RAISE EXCEPTION 'the role app_releaser does not exist: create it first (infra/postgres/init/01-roles.sql, and GRANT app_rw TO app_releaser)';
  END IF;
  IF NOT pg_has_role('app_releaser', 'app_rw', 'USAGE') THEN
    RAISE EXCEPTION 'app_releaser must be a member of app_rw (GRANT app_rw TO app_releaser)';
  END IF;
END
$$;
--> statement-breakpoint
-- 1. The delivery columns, the releaser's alone.
REVOKE UPDATE ("status", "released_at", "package_key", "package_sha256", "package_bytes", "link_expires_at", "failure_code")
  ON "archive_release_request" FROM app_rw;
--> statement-breakpoint
GRANT UPDATE ("status", "released_at", "package_key", "package_sha256", "package_bytes", "link_expires_at", "failure_code")
  ON "archive_release_request" TO app_releaser;
--> statement-breakpoint
-- 2. What tells the releaser what to do, and its heartbeat.
REVOKE EXECUTE ON FUNCTION app.archive_release_due(integer) FROM app_rw;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.archive_release_cleanup_due(integer) FROM app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_due(integer) TO app_releaser;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_cleanup_due(integer) TO app_releaser;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_expire_stale(integer) TO app_releaser;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.releaser_beat(timestamp with time zone) TO app_releaser;
--> statement-breakpoint
-- 3. The platform trail. The generic function of 0653 keeps the two actions of the worker.
CREATE OR REPLACE FUNCTION app.write_archive_audit(
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_reason text,
  p_metadata jsonb
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF p_action NOT IN ('archive.written', 'archive.verified') THEN
      RAISE EXCEPTION 'the archive trail of the worker does not take the action %', p_action USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.platform_audit_event
      (operator_id, target_tenant_id, action, outcome, reason, resource_type, resource_id, metadata)
    VALUES
      (NULL, current_setting('app.tenant_id')::uuid, p_action, 'allow', p_reason, p_resource_type,
       p_resource_id, coalesce(p_metadata, '{}'::jsonb));
  END
  $$;
--> statement-breakpoint
-- The release: the archive was opened (`archive.accessed`) and a request was delivered, failed or
-- expired (`archive.released`). Only about a request of the organization of the transaction that is
-- past the approval, so a forged entry about a request that does not exist or was never approved is
-- refused. The releaser alone may call it.
CREATE FUNCTION app.write_release_audit(
  p_action text,
  p_request uuid,
  p_reason text,
  p_metadata jsonb
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF p_action NOT IN ('archive.accessed', 'archive.released') THEN
      RAISE EXCEPTION 'the release trail does not take the action %', p_action USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.archive_release_request r
       WHERE r.id = p_request
         AND r.target_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND r.status IN ('approved', 'released', 'failed', 'expired')
    ) THEN
      RAISE EXCEPTION 'there is no approved release request of this organization with that id' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.platform_audit_event
      (operator_id, target_tenant_id, action, outcome, reason, resource_type, resource_id, metadata)
    VALUES
      (NULL, current_setting('app.tenant_id')::uuid, p_action, 'allow', p_reason,
       'archive_release_request', p_request, coalesce(p_metadata, '{}'::jsonb));
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.write_release_audit(text, uuid, text, jsonb) FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.write_release_audit(text, uuid, text, jsonb) TO app_releaser;
--> statement-breakpoint
-- The download: the API writes the one entry that says a released package was handed over, and
-- nothing else. The request must be released and of the organization of the transaction.
CREATE FUNCTION app.write_download_audit(p_request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_kind text;
  BEGIN
    SELECT r.requester_kind INTO v_kind
      FROM public.archive_release_request r
     WHERE r.id = p_request
       AND r.target_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       AND r.status = 'released';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'there is no released request of this organization with that id' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.platform_audit_event
      (operator_id, target_tenant_id, action, outcome, resource_type, resource_id, metadata)
    VALUES
      (NULL, current_setting('app.tenant_id')::uuid, 'archive.released', 'allow',
       'archive_release_request', p_request,
       jsonb_build_object('phase', 'downloaded', 'requesterKind', v_kind));
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.write_download_audit(uuid) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.write_download_audit(uuid) TO app_rw;
