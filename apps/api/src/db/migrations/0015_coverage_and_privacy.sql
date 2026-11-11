CREATE TABLE "patient_coverage" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_plan_id" uuid NOT NULL,
	"member_number" text,
	"valid_from" date,
	"valid_to" date,
	"is_primary" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "patient_coverage_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_coverage_dates_check" CHECK ("patient_coverage"."valid_from" is null or "patient_coverage"."valid_to" is null or "patient_coverage"."valid_to" >= "patient_coverage"."valid_from"),
	CONSTRAINT "patient_coverage_end_check" CHECK (("patient_coverage"."ended_at" is null) = ("patient_coverage"."end_reason" is null) and ("patient_coverage"."end_reason" is null or "patient_coverage"."end_reason" in ('replaced', 'removed'))),
	CONSTRAINT "patient_coverage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "patient_coverage_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "payer_plan" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payer_id" uuid,
	"custom_name" text,
	"plan_name" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "payer_plan_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payer_plan_one_source_check" CHECK (("payer_plan"."payer_id" is null) <> ("payer_plan"."custom_name" is null)),
	CONSTRAINT "payer_plan_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "payer_plan_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id")
);
--> statement-breakpoint
CREATE TABLE "data_processing_consent" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"text_key" text NOT NULL,
	"text_version" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "data_processing_consent_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "data_processing_consent_revocation_check" CHECK (("data_processing_consent"."revoked_at" is null) = ("data_processing_consent"."revoked_by" is null)),
	CONSTRAINT "data_processing_consent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "data_processing_consent_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "patient_rights_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_by" uuid NOT NULL,
	"note" text,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by" uuid,
	CONSTRAINT "patient_rights_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_rights_request_kind_check" CHECK ("patient_rights_request"."kind" in ('access', 'rectification')),
	CONSTRAINT "patient_rights_request_status_check" CHECK ("patient_rights_request"."status" in ('open', 'fulfilled')),
	CONSTRAINT "patient_rights_request_fulfilled_check" CHECK (("patient_rights_request"."status" = 'fulfilled') = ("patient_rights_request"."fulfilled_at" is not null and "patient_rights_request"."fulfilled_by" is not null)),
	CONSTRAINT "patient_rights_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "patient_rights_request_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "patient_coverage" ADD CONSTRAINT "patient_coverage_payer_plan_fkey" FOREIGN KEY ("tenant_id","payer_plan_id") REFERENCES "public"."payer_plan"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_coverage_primary_key" ON "patient_coverage" USING btree ("tenant_id","patient_id") WHERE "patient_coverage"."is_primary" and "patient_coverage"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "patient_coverage_live_idx" ON "patient_coverage" USING btree ("tenant_id","patient_id") WHERE "patient_coverage"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_plan_catalog_key" ON "payer_plan" USING btree ("tenant_id","payer_id",coalesce("plan_name", '')) WHERE "payer_plan"."payer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_plan_custom_key" ON "payer_plan" USING btree ("tenant_id",lower("custom_name"),coalesce("plan_name", '')) WHERE "payer_plan"."custom_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "data_processing_consent_live_key" ON "data_processing_consent" USING btree ("tenant_id","patient_id") WHERE "data_processing_consent"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "data_processing_consent_patient_idx" ON "data_processing_consent" USING btree ("tenant_id","patient_id","granted_at");--> statement-breakpoint
CREATE INDEX "patient_rights_request_patient_idx" ON "patient_rights_request" USING btree ("tenant_id","patient_id","created_at");
--> statement-breakpoint
ALTER TABLE "payer_plan" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payer_plan" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payer_plan" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "patient_coverage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_coverage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_coverage" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "data_processing_consent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "data_processing_consent" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_processing_consent" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "patient_rights_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_rights_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_rights_request" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Coverages, payer plans, consents and rights requests are ended or deactivated, never deleted:
-- what a patient was covered by, and what they agreed to, is part of the record.
REVOKE DELETE, TRUNCATE ON "payer_plan", "patient_coverage", "data_processing_consent", "patient_rights_request" FROM app_rw;
