CREATE TABLE "archive_release_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"requester_kind" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"scope_document_type" text,
	"scope_document" text,
	"scope_matricula_jurisdiction" text,
	"scope_matricula" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"identity_checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by" uuid NOT NULL,
	"identity_verified_by" uuid,
	"identity_verified_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_reason" text,
	"released_at" timestamp with time zone,
	"package_key" text,
	"package_sha256" text,
	"package_bytes" bigint,
	"link_expires_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "archive_release_request_kind_check" CHECK ("archive_release_request"."requester_kind" in ('patient', 'professional')),
	CONSTRAINT "archive_release_request_status_check" CHECK ("archive_release_request"."status" in ('requested', 'identity_verified', 'approved', 'released', 'rejected', 'expired', 'failed')),
	CONSTRAINT "archive_release_request_scope_check" CHECK (("archive_release_request"."requester_kind" = 'patient' and "archive_release_request"."scope_document_type" is not null and "archive_release_request"."scope_document" is not null and "archive_release_request"."scope_matricula_jurisdiction" is null and "archive_release_request"."scope_matricula" is null)
        or ("archive_release_request"."requester_kind" = 'professional' and "archive_release_request"."scope_matricula_jurisdiction" is not null and "archive_release_request"."scope_matricula" is not null and "archive_release_request"."scope_document_type" is null and "archive_release_request"."scope_document" is null)),
	CONSTRAINT "archive_release_request_text_check" CHECK (length("archive_release_request"."requester_name") between 2 and 120 and length("archive_release_request"."requester_email") between 3 and 254 and length("archive_release_request"."reason") between 5 and 500),
	CONSTRAINT "archive_release_request_four_eyes_check" CHECK ("archive_release_request"."approved_by" is null or "archive_release_request"."identity_verified_by" is null or "archive_release_request"."approved_by" <> "archive_release_request"."identity_verified_by"),
	CONSTRAINT "archive_release_request_approved_check" CHECK ("archive_release_request"."status" not in ('approved', 'released') or ("archive_release_request"."identity_verified_by" is not null and "archive_release_request"."identity_verified_at" is not null and "archive_release_request"."approved_by" is not null and "archive_release_request"."approved_at" is not null and "archive_release_request"."expires_at" is not null)),
	CONSTRAINT "archive_release_request_checklist_check" CHECK ("archive_release_request"."identity_verified_by" is null or "archive_release_request"."identity_checklist" @> '{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb),
	CONSTRAINT "archive_release_request_released_check" CHECK (("archive_release_request"."status" = 'released') = ("archive_release_request"."released_at" is not null and "archive_release_request"."package_key" is not null and "archive_release_request"."link_expires_at" is not null)),
	CONSTRAINT "archive_release_request_failed_check" CHECK (("archive_release_request"."status" = 'failed') = ("archive_release_request"."failure_code" is not null)),
	CONSTRAINT "archive_release_request_rejected_check" CHECK (("archive_release_request"."status" = 'rejected') = ("archive_release_request"."rejected_by" is not null and "archive_release_request"."rejected_reason" is not null)),
	-- Inline on purpose (the convention of the tenant tables): `tenant` has FORCE row level security.
	CONSTRAINT "archive_release_request_tenant_fkey" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE INDEX "archive_release_request_status_idx" ON "archive_release_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "archive_release_request_tenant_idx" ON "archive_release_request" USING btree ("target_tenant_id","created_at");
--> statement-breakpoint
-- Stage 6, track C (retention), S6.10: who may read and write the table of release requests. It is a
-- PLATFORM table (no tenant_id of its own): the request is about the platform's custody of an archive.
--
--   app_operator  reads every request (it must see the requester's identity to verify it out of band),
--                 records one, ticks the identity checklist, approves or rejects. It can NOT write the
--                 columns of the delivery (package, link, release): it never touches content.
--   app_rw        (the releaser, and the API for the link) reads the requests of the organization of
--                 its transaction only, and writes the delivery. It can not insert a request or approve.
--
-- Row level security enforces the second line: the runtime role sees a request only when
-- `app.tenant_id` is the organization the request is about. A trigger lets a status move only along
-- the allowed steps and only by the role that owns each one.
ALTER TABLE "archive_release_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "archive_release_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "operator_all" ON "archive_release_request" FOR ALL TO app_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "runtime_of_its_tenant" ON "archive_release_request" FOR SELECT TO app_rw
  USING ("target_tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
CREATE POLICY "runtime_delivery" ON "archive_release_request" FOR UPDATE TO app_rw
  USING ("target_tenant_id" = current_setting('app.tenant_id')::uuid)
  WITH CHECK ("target_tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The owner of the table needs a policy of its own to see every request under FORCE (for the definer
-- function that tells the releaser which requests are approved).
CREATE POLICY "owner_lookup" ON "archive_release_request" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
REVOKE ALL ON "archive_release_request" FROM PUBLIC, app_rw, app_operator;
--> statement-breakpoint
GRANT SELECT ON "archive_release_request" TO app_operator, app_rw;
--> statement-breakpoint
GRANT INSERT ("target_tenant_id", "requester_kind", "requester_name", "requester_email", "scope_document_type", "scope_document", "scope_matricula_jurisdiction", "scope_matricula", "reason", "recorded_by")
  ON "archive_release_request" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("status", "identity_checklist", "identity_verified_by", "identity_verified_at", "approved_by", "approved_at", "expires_at", "rejected_by", "rejected_reason", "updated_at")
  ON "archive_release_request" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("status", "released_at", "package_key", "package_sha256", "package_bytes", "link_expires_at", "downloaded_at", "failure_code", "updated_at")
  ON "archive_release_request" TO app_rw;
--> statement-breakpoint
-- A request moves along its steps, each by the role that owns it; nobody goes backwards or skips one.
--   operator: requested -> identity_verified -> approved, and requested|identity_verified|approved -> rejected
--   runtime:  approved -> released | expired | failed
-- Anything else is refused. The owner (a migration, an administrator) is not bound: it is not an
-- application role.
CREATE FUNCTION app.archive_release_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.status = OLD.status OR current_user NOT IN ('app_operator', 'app_rw') THEN
      RETURN NEW;
    END IF;
    IF current_user = 'app_operator' AND (
         (OLD.status = 'requested' AND NEW.status = 'identity_verified')
      OR (OLD.status = 'identity_verified' AND NEW.status = 'approved')
      OR (OLD.status IN ('requested', 'identity_verified', 'approved') AND NEW.status = 'rejected')
    ) THEN
      RETURN NEW;
    END IF;
    IF current_user = 'app_rw' AND OLD.status = 'approved' AND NEW.status IN ('released', 'expired', 'failed') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a release request cannot go from % to % for this role', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER archive_release_request_transition
  BEFORE UPDATE ON "archive_release_request"
  FOR EACH ROW EXECUTE FUNCTION app.archive_release_transition();
--> statement-breakpoint
-- The approved requests the releaser has to carry out: ids and the organization, nothing else.
CREATE FUNCTION app.archive_release_due(p_limit integer) RETURNS TABLE (request_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.target_tenant_id
      FROM public.archive_release_request r
     WHERE r.status = 'approved'
     ORDER BY r.approved_at, r.id
     LIMIT greatest(least(p_limit, 100), 1)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_release_due(integer) FROM PUBLIC, app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_release_due(integer) TO app_rw;
--> statement-breakpoint
-- Whether an organization has an archive that is written: the only thing the operator may ask about the
-- archive before it records a release request (the operator has no privilege on the table).
CREATE FUNCTION app.archive_is_written(p_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.tenant_archive a WHERE a.tenant_id = p_tenant AND a.status = 'written'
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.archive_is_written(uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.archive_is_written(uuid) TO app_operator;
