CREATE TABLE "tenant_archive" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archive_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"key_version" integer NOT NULL,
	"manifest_key" text,
	"manifest_sha256" text,
	"objects_count" integer,
	"bytes_total" bigint,
	"retain_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verify_status" text,
	"verify_problems" integer,
	"failure_code" text,
	CONSTRAINT "tenant_archive_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_archive_status_check" CHECK ("tenant_archive"."status" in ('pending', 'written', 'failed')),
	CONSTRAINT "tenant_archive_written_check" CHECK (("tenant_archive"."status" = 'written') = ("tenant_archive"."manifest_key" is not null and "tenant_archive"."manifest_sha256" is not null and "tenant_archive"."objects_count" is not null and "tenant_archive"."bytes_total" is not null and "tenant_archive"."retain_until" is not null and "tenant_archive"."archived_at" is not null)),
	CONSTRAINT "tenant_archive_verify_check" CHECK ("tenant_archive"."verify_status" is null or "tenant_archive"."verify_status" in ('ok', 'corrupted', 'missing', 'overwritten')),
	CONSTRAINT "tenant_archive_failed_check" CHECK (("tenant_archive"."status" = 'failed') = ("tenant_archive"."failure_code" is not null)),
	CONSTRAINT "tenant_archive_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_archive_tenant_key" ON "tenant_archive" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "tenant_archive" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_archive" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_archive" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The archive state is never deleted, and the runtime role records only the outcome of the steps: it
-- cannot move an archive to another organization or key version.
REVOKE DELETE, TRUNCATE ON "tenant_archive" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE ON "tenant_archive" FROM app_rw;
--> statement-breakpoint
GRANT UPDATE ("status", "manifest_key", "manifest_sha256", "objects_count", "bytes_total", "retain_until", "archived_at", "verified_at", "verify_status", "verify_problems", "failure_code", "updated_at")
  ON "tenant_archive" TO app_rw;
--> statement-breakpoint
-- Stage 6, track C (retention), S6.09. Functions that the archive jobs need across organizations or
-- on the platform trail, which the runtime role has no right to read or write by itself. Each pins its
-- search path, is revoked from PUBLIC and is on the allowlist of definer functions.
--
-- The owner of the tables needs a read-only policy of its own to see across organizations under FORCE
-- row level security (the pattern of migration 0392); the runtime role gets nothing new.
CREATE POLICY "tenant_archive_owner_lookup" ON "tenant_archive" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
-- The organizations whose archive is due: their export was requested more than p_after_days days ago
-- (the cancellation, from the administrative package) and no archive exists, or the archive started
-- and has not finished for over an hour. Ids only.
CREATE FUNCTION app.archive_due(p_after_days integer, p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT e.tenant_id
      FROM public.export_package e
     WHERE e.kind = 'administrative'
       AND e.created_at <= now() - make_interval(days => greatest(p_after_days, 0))
       AND NOT EXISTS (
         SELECT 1 FROM public.tenant_archive a
          WHERE a.tenant_id = e.tenant_id
            AND (a.status = 'written' OR a.status = 'failed'
                 OR (a.status = 'pending' AND a.updated_at > now() - interval '1 hour'))
       )
     ORDER BY e.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_due(integer, integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_due(integer, integer) TO app_rw;
--> statement-breakpoint
-- The organizations whose written archive was never verified, or not for p_every_days days.
CREATE FUNCTION app.archive_verify_due(p_every_days integer, p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.tenant_id
      FROM public.tenant_archive a
     WHERE a.status = 'written'
       AND (a.verified_at IS NULL OR a.verified_at <= now() - make_interval(days => greatest(p_every_days, 0)))
     ORDER BY a.verified_at NULLS FIRST, a.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_verify_due(integer, integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_verify_due(integer, integer) TO app_rw;
--> statement-breakpoint
-- Writes one entry of the PLATFORM trail about the organization of the transaction. The runtime role
-- has no privilege on that table (the platform's trail is the operator's and the sealer's), and the
-- archive is the platform's to answer for, so the archive jobs write their entries through this and
-- only these four actions, only about the organization they run for, never as an operator.
CREATE FUNCTION app.write_archive_audit(
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
    IF p_action NOT IN ('archive.written', 'archive.verified', 'archive.accessed', 'archive.released') THEN
      RAISE EXCEPTION 'the archive trail does not take the action %', p_action USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.platform_audit_event
      (operator_id, target_tenant_id, action, outcome, reason, resource_type, resource_id, metadata)
    VALUES
      (NULL, current_setting('app.tenant_id')::uuid, p_action, 'allow', p_reason, p_resource_type,
       p_resource_id, coalesce(p_metadata, '{}'::jsonb));
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.write_archive_audit(text, text, uuid, text, jsonb) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.write_archive_audit(text, text, uuid, text, jsonb) TO app_rw;
--> statement-breakpoint
-- What the operator console shows about the archives: the state and the counts of each organization,
-- never a key, an object name or a record. The operator has no privilege on the table.
CREATE FUNCTION app.archive_overview(p_limit integer)
  RETURNS TABLE (
    tenant_id uuid,
    status text,
    archived_at timestamp with time zone,
    objects_count integer,
    bytes_total bigint,
    retain_until timestamp with time zone,
    verified_at timestamp with time zone,
    verify_status text,
    verify_problems integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.tenant_id, a.status, a.archived_at, a.objects_count, a.bytes_total,
           a.retain_until, a.verified_at, a.verify_status, a.verify_problems
      FROM public.tenant_archive a
     ORDER BY a.created_at DESC, a.tenant_id
     LIMIT greatest(least(p_limit, 200), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_overview(integer) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_overview(integer) TO app_operator;
