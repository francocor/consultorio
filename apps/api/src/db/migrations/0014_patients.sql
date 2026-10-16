-- Search compares names without accents and in lower case. `unaccent` is only STABLE, which an
-- index or a generated column cannot use, so this wrapper pins the dictionary and is marked
-- IMMUTABLE (the dictionary never changes under a running database).
CREATE FUNCTION app.f_unaccent(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = pg_catalog, public
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, input) $$;
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"family_name" text NOT NULL,
	"given_names" text NOT NULL,
	"birth_date" date NOT NULL,
	"sex" text,
	"national_id_type" text,
	"national_id" text,
	"phone" text,
	"email" "citext",
	"address" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"admin_notes" text,
	"safety_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text DEFAULT 'staff' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"search_name" text GENERATED ALWAYS AS (lower(app.f_unaccent(family_name || ' ' || given_names))) STORED NOT NULL,
	"phone_digits" text GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) STORED NOT NULL,
	CONSTRAINT "patient_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_document_pair_check" CHECK (("patient"."national_id_type" is null) = ("patient"."national_id" is null)),
	CONSTRAINT "patient_sex_check" CHECK ("patient"."sex" is null or "patient"."sex" in ('female', 'male', 'non_binary', 'undisclosed')),
	CONSTRAINT "patient_origin_check" CHECK ("patient"."origin" in ('staff', 'online')),
	CONSTRAINT "patient_status_check" CHECK ("patient"."status" in ('active', 'inactive')),
	CONSTRAINT "patient_version_check" CHECK ("patient"."version" >= 1),
	CONSTRAINT "patient_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "patient_representative" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"relation" text NOT NULL,
	"phone" text,
	"email" "citext",
	"majority_review_on" date NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "patient_representative_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_representative_relation_check" CHECK ("patient_representative"."relation" in ('mother', 'father', 'guardian', 'other')),
	CONSTRAINT "patient_representative_contact_check" CHECK ("patient_representative"."phone" is not null or "patient_representative"."email" is not null),
	CONSTRAINT "patient_representative_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "patient_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"changed_by" uuid,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "patient_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_version_tenant_id_patient_id_version_key" UNIQUE("tenant_id","patient_id","version"),
	CONSTRAINT "patient_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "patient_representative" ADD CONSTRAINT "patient_representative_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_version" ADD CONSTRAINT "patient_version_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_document_key" ON "patient" USING btree ("tenant_id","national_id_type","national_id") WHERE "patient"."national_id" is not null;--> statement-breakpoint
CREATE INDEX "patient_name_order_idx" ON "patient" USING btree ("tenant_id","family_name","given_names","id");--> statement-breakpoint
CREATE INDEX "patient_search_name_idx" ON "patient" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_phone_digits_idx" ON "patient" USING btree ("tenant_id","phone_digits");--> statement-breakpoint
CREATE INDEX "patient_national_id_idx" ON "patient" USING btree ("tenant_id","national_id");--> statement-breakpoint
CREATE INDEX "patient_representative_live_idx" ON "patient_representative" USING btree ("tenant_id","patient_id") WHERE "patient_representative"."ended_at" is null;--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "patient_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_version" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_version" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "patient_representative" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_representative" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_representative" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Patients are deactivated, never deleted; the history of their demographics is append-only.
REVOKE DELETE, TRUNCATE ON "patient" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "patient_representative" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_version" FROM app_rw;
--> statement-breakpoint
-- The care tables name a patient (S1.17 left the column without a key). They are FORCE row level
-- secured, so validating the new keys needs a tenant context a migration does not have: a nil
-- tenant makes the policies see no rows, and the tables are empty at this point (no route writes a
-- care assignment before the patient exists).
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
--> statement-breakpoint
ALTER TABLE "care_assignment" ADD CONSTRAINT "care_assignment_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "care_relationship" ADD CONSTRAINT "care_relationship_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id");
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
