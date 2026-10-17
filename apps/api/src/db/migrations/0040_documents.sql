CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"appointment_id" uuid,
	"category" text NOT NULL,
	"classification" text NOT NULL,
	"original_name" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"content_type" text,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'quarantined' NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text,
	"scan_result" text,
	"rejection_reason" text,
	"scan_attempts" integer DEFAULT 0 NOT NULL,
	"last_scan_error_at" timestamp with time zone,
	"scanned_at" timestamp with time zone,
	"upload_completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"uploaded_by" uuid NOT NULL,
	"author_professional_id" uuid,
	"replaces_document_id" uuid,
	"duplicate_of_id" uuid,
	"hidden_at" timestamp with time zone,
	"hidden_by" uuid,
	"hidden_reason" text,
	CONSTRAINT "document_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_status_check" CHECK ("document"."status" in ('quarantined', 'available', 'rejected', 'hidden')),
	CONSTRAINT "document_classification_check" CHECK ("document"."classification" in ('clinical', 'administrative')),
	CONSTRAINT "document_category_check" CHECK (("document"."classification" = 'clinical' and "document"."category" in ('lab_result', 'imaging', 'referral', 'clinical_report', 'other_clinical'))
        or ("document"."classification" = 'administrative' and "document"."category" in ('id_copy', 'coverage_card', 'signed_form', 'other_administrative'))),
	CONSTRAINT "document_known_category_check" CHECK ("document"."category" in ('lab_result', 'imaging', 'referral', 'clinical_report', 'other_clinical', 'id_copy', 'coverage_card', 'signed_form', 'other_administrative')),
	CONSTRAINT "document_clinical_author_check" CHECK ("document"."classification" <> 'clinical' or "document"."author_professional_id" is not null),
	CONSTRAINT "document_size_check" CHECK ("document"."size_bytes" between 1 and 20971520),
	CONSTRAINT "document_declared_type_check" CHECK ("document"."declared_content_type" in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "document_content_type_check" CHECK ("document"."content_type" is null or "document"."content_type" in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "document_sha256_check" CHECK ("document"."sha256" is null or "document"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_available_check" CHECK ("document"."status" not in ('available', 'hidden') or ("document"."sha256" is not null and "document"."content_type" is not null)),
	CONSTRAINT "document_hidden_check" CHECK ("document"."status" <> 'hidden' or ("document"."hidden_at" is not null and "document"."hidden_by" is not null and "document"."hidden_reason" is not null)),
	CONSTRAINT "document_rejected_check" CHECK ("document"."status" <> 'rejected' or "document"."rejection_reason" is not null),
	CONSTRAINT "document_rejection_reason_check" CHECK ("document"."rejection_reason" is null or "document"."rejection_reason" in ('infected', 'type_not_allowed', 'type_mismatch', 'corrupt', 'too_large')),
	CONSTRAINT "document_scan_attempts_check" CHECK ("document"."scan_attempts" >= 0),
	CONSTRAINT "document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "document_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "document_author_professional_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_replaces_fkey" FOREIGN KEY ("tenant_id","replaces_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_duplicate_of_fkey" FOREIGN KEY ("tenant_id","duplicate_of_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_patient_idx" ON "document" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "document_scan_backlog_idx" ON "document" USING btree ("tenant_id","upload_completed_at") WHERE "document"."status" = 'quarantined' and "document"."upload_completed_at" is not null;--> statement-breakpoint
CREATE INDEX "document_unfinished_idx" ON "document" USING btree ("tenant_id","created_at") WHERE "document"."upload_completed_at" is null and "document"."abandoned_at" is null;--> statement-breakpoint
CREATE INDEX "document_sha256_idx" ON "document" USING btree ("tenant_id","patient_id","sha256") WHERE "document"."sha256" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_replaces_live_key" ON "document" USING btree ("tenant_id","replaces_document_id") WHERE "document"."replaces_document_id" is not null and "document"."status" <> 'rejected' and "document"."abandoned_at" is null;
--> statement-breakpoint
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Access follows the classification (documents, "Classification and access rules"). An
-- administrative document is visible to the staff of the organization. A clinical one is visible
-- only to a health professional who may read it: the same rule as a clinical note, through
-- app.clinical_readable (author, treating professional, sharing scope). An owner, an admin or
-- reception therefore reads ZERO clinical rows, even in plain SQL. Background jobs act as the
-- system user (the nil UUID that withTenant is given by the job runner) and see both, because
-- they have to scan every file. Documents follow the general ceiling of the sharing scope.
CREATE POLICY "document_classification" ON "document" AS RESTRICTIVE USING (
  "classification" = 'administrative'
  OR current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
  OR (
    nullif(current_setting('app.professional_id', true), '') IS NOT NULL
    AND app.clinical_readable("patient_id", "author_professional_id", 'default', NULL::text)
  )
);
--> statement-breakpoint
-- Documents are never deleted (documents, "Immutability, replacement and removal"): a corrected
-- file is a new row, an upload by mistake is hidden with a reason, an abandoned upload is marked.
REVOKE DELETE, TRUNCATE ON "document" FROM app_rw;
--> statement-breakpoint
-- What a row may become. The identity of a document is fixed; the results of the scan are written
-- once; the storage key moves only when the scan releases the file; and the status only goes
-- forward: quarantined to available or rejected, available to hidden.
CREATE FUNCTION app.guard_document() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
       OR NEW.original_name IS DISTINCT FROM OLD.original_name
       OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
       OR NEW.replaces_document_id IS DISTINCT FROM OLD.replaces_document_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.author_professional_id IS NOT NULL
           AND NEW.author_professional_id IS DISTINCT FROM OLD.author_professional_id) THEN
      RAISE EXCEPTION 'a document keeps its identity' USING ERRCODE = '42501';
    END IF;
    IF OLD.upload_completed_at IS NOT NULL
       AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
      RAISE EXCEPTION 'the size of a confirmed upload does not change' USING ERRCODE = '42501';
    END IF;
    IF (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
       OR (OLD.content_type IS NOT NULL AND NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
      RAISE EXCEPTION 'the result of the scan is written once' USING ERRCODE = '42501';
    END IF;
    IF OLD.hidden_at IS NOT NULL
       AND (NEW.hidden_at IS DISTINCT FROM OLD.hidden_at
            OR NEW.hidden_by IS DISTINCT FROM OLD.hidden_by
            OR NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason) THEN
      RAISE EXCEPTION 'a hidden document keeps its reason' USING ERRCODE = '42501';
    END IF;
    IF NEW.object_key IS DISTINCT FROM OLD.object_key
       AND NOT (OLD.status = 'quarantined' AND NEW.status = 'available') THEN
      RAISE EXCEPTION 'the storage key moves only when the scan releases the file' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'quarantined' AND NEW.status IN ('available', 'rejected'))
                OR (OLD.status = 'available' AND NEW.status = 'hidden')) THEN
      RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER document_guard
  BEFORE UPDATE ON "document"
  FOR EACH ROW EXECUTE FUNCTION app.guard_document();
