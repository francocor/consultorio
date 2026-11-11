CREATE TABLE "addendum" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"visibility" text NOT NULL,
	"template_kind" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"content_enc" "bytea" NOT NULL,
	CONSTRAINT "addendum_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "addendum_visibility_check" CHECK ("addendum"."visibility" in ('default', 'author_only')),
	CONSTRAINT "addendum_kind_check" CHECK ("addendum"."kind" in ('correction', 'rectification')),
	CONSTRAINT "addendum_reason_check" CHECK (length(btrim("addendum"."reason")) between 1 and 500),
	CONSTRAINT "addendum_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "addendum_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "addendum_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "clinical_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	"template_kind" text NOT NULL,
	"template_version" integer NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"draft_content_enc" "bytea",
	"signed_at" timestamp with time zone,
	"error_reason" text,
	"error_marked_by" uuid,
	"error_marked_at" timestamp with time zone,
	CONSTRAINT "clinical_note_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "clinical_note_status_check" CHECK ("clinical_note"."status" in ('draft', 'signed', 'entered_in_error')),
	CONSTRAINT "clinical_note_visibility_check" CHECK ("clinical_note"."visibility" in ('default', 'author_only')),
	CONSTRAINT "clinical_note_template_kind_check" CHECK ("clinical_note"."template_kind" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "clinical_note_template_version_check" CHECK ("clinical_note"."template_version" >= 1),
	CONSTRAINT "clinical_note_draft_revision_check" CHECK ("clinical_note"."draft_revision" >= 0),
	CONSTRAINT "clinical_note_state_check" CHECK ((
        ("clinical_note"."status" = 'draft'
          and "clinical_note"."signed_at" is null
          and "clinical_note"."error_reason" is null and "clinical_note"."error_marked_by" is null
          and "clinical_note"."error_marked_at" is null)
        or ("clinical_note"."status" = 'signed'
          and "clinical_note"."signed_at" is not null
          and "clinical_note"."draft_content_enc" is null
          and "clinical_note"."error_reason" is null and "clinical_note"."error_marked_by" is null
          and "clinical_note"."error_marked_at" is null)
        or ("clinical_note"."status" = 'entered_in_error'
          and length(btrim("clinical_note"."error_reason")) between 1 and 500
          and "clinical_note"."error_marked_by" is not null and "clinical_note"."error_marked_at" is not null)
      )),
	CONSTRAINT "clinical_note_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "clinical_note_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "clinical_note_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"appointment_id" uuid,
	"template_kind" text NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	CONSTRAINT "encounter_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "encounter_visibility_check" CHECK ("encounter"."visibility" in ('default', 'author_only')),
	CONSTRAINT "encounter_template_kind_check" CHECK ("encounter"."template_kind" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "encounter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "encounter_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "encounter_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "note_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"visibility" text NOT NULL,
	"template_kind" text NOT NULL,
	"template_version" integer NOT NULL,
	"version_no" integer NOT NULL,
	"content_enc" "bytea" NOT NULL,
	"content_hash" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "note_version_tenant_id_note_id_version_no_key" UNIQUE("tenant_id","note_id","version_no"),
	CONSTRAINT "note_version_visibility_check" CHECK ("note_version"."visibility" in ('default', 'author_only')),
	CONSTRAINT "note_version_version_no_check" CHECK ("note_version"."version_no" >= 1),
	CONSTRAINT "note_version_template_version_check" CHECK ("note_version"."template_version" >= 1),
	CONSTRAINT "note_version_hash_check" CHECK ("note_version"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "note_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "note_version_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "note_version_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "addendum" ADD CONSTRAINT "addendum_note_fkey" FOREIGN KEY ("tenant_id","note_id") REFERENCES "public"."clinical_note"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_fkey" FOREIGN KEY ("tenant_id","encounter_id") REFERENCES "public"."encounter"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_note_fkey" FOREIGN KEY ("tenant_id","note_id") REFERENCES "public"."clinical_note"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addendum_note_idx" ON "addendum" USING btree ("tenant_id","note_id","created_at");--> statement-breakpoint
CREATE INDEX "addendum_patient_idx" ON "addendum" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_note_encounter_key" ON "clinical_note" USING btree ("tenant_id","encounter_id");--> statement-breakpoint
CREATE INDEX "clinical_note_patient_idx" ON "clinical_note" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "clinical_note_author_drafts_idx" ON "clinical_note" USING btree ("tenant_id","author_professional_id","updated_at") WHERE "clinical_note"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "encounter_patient_idx" ON "encounter" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "encounter_appointment_idx" ON "encounter" USING btree ("tenant_id","appointment_id") WHERE "encounter"."appointment_id" is not null;--> statement-breakpoint
CREATE INDEX "note_version_patient_idx" ON "note_version" USING btree ("tenant_id","patient_id");
--> statement-breakpoint
ALTER TABLE "addendum" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "addendum" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "addendum" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "clinical_note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinical_note" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "encounter" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "note_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "note_version" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "note_version" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Clinical backstop (ADR-003): on top of tenant isolation, only a health professional's
-- transaction sees any row, and only the rows the care relationship and the sharing scope allow.
-- An owner, an admin or reception has no professional id, so it sees zero rows of these tables
-- even if the application had a bug. The template of a note is the sharing unit.
CREATE POLICY "clinical_professionals_only" ON "encounter" AS RESTRICTIVE USING (nullif(current_setting('app.professional_id', true), '') IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "encounter" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", "template_kind"));
--> statement-breakpoint
CREATE POLICY "clinical_professionals_only" ON "clinical_note" AS RESTRICTIVE USING (nullif(current_setting('app.professional_id', true), '') IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "clinical_note" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", "template_kind"));
--> statement-breakpoint
CREATE POLICY "clinical_professionals_only" ON "note_version" AS RESTRICTIVE USING (nullif(current_setting('app.professional_id', true), '') IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "note_version" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", "template_kind"));
--> statement-breakpoint
CREATE POLICY "clinical_professionals_only" ON "addendum" AS RESTRICTIVE USING (nullif(current_setting('app.professional_id', true), '') IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "addendum" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", "template_kind"));
--> statement-breakpoint
-- A draft is its author's working copy: no other professional reads it, whatever the care
-- relationship or the sharing scope. It joins the shared record only once it is signed.
CREATE POLICY "clinical_draft_author_only" ON "clinical_note" AS RESTRICTIVE USING ("status" <> 'draft' OR "author_professional_id" = nullif(current_setting('app.professional_id', true), '')::uuid);
--> statement-breakpoint
-- Only a TREATING professional adds an addendum (clinical-records, "Addenda and corrections"):
-- reading through the sharing scope is not enough. The author column must be the acting one.
CREATE POLICY "addendum_treating_only" ON "addendum" AS RESTRICTIVE FOR INSERT WITH CHECK ("author_professional_id" = nullif(current_setting('app.professional_id', true), '')::uuid AND app.is_treating("patient_id", "author_professional_id"));
--> statement-breakpoint
-- Nothing clinical is ever deleted or emptied by the application. Versions and addenda are
-- insert-only; an encounter may only change its visibility, and only while its note is a draft
-- (the triggers of migration 0032 enforce the details, also against the owner).
REVOKE DELETE, TRUNCATE ON "encounter", "clinical_note", "note_version", "addendum" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE ON "note_version", "addendum" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE ON "encounter" FROM app_rw;
--> statement-breakpoint
GRANT UPDATE ("visibility", "updated_at") ON "encounter" TO app_rw;
