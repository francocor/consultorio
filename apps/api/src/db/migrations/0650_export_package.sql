CREATE TABLE "export_package" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"professional_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_key" text,
	"file_name" text,
	"size_bytes" bigint,
	"sha256" text,
	"entry_count" integer,
	"built_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "export_package_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "export_package_kind_check" CHECK ("export_package"."kind" in ('administrative', 'clinical')),
	CONSTRAINT "export_package_status_check" CHECK ("export_package"."status" in ('queued', 'ready', 'failed')),
	CONSTRAINT "export_package_professional_check" CHECK (("export_package"."kind" = 'clinical') = ("export_package"."professional_id" is not null)),
	CONSTRAINT "export_package_ready_check" CHECK (("export_package"."status" = 'ready') = ("export_package"."object_key" is not null and "export_package"."file_name" is not null and "export_package"."size_bytes" is not null and "export_package"."sha256" is not null and "export_package"."built_at" is not null)),
	CONSTRAINT "export_package_failed_check" CHECK (("export_package"."status" = 'failed') = ("export_package"."failure_code" is not null)),
	CONSTRAINT "export_package_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "export_package_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_package_administrative_key" ON "export_package" USING btree ("tenant_id") WHERE "export_package"."kind" = 'administrative';--> statement-breakpoint
CREATE UNIQUE INDEX "export_package_clinical_key" ON "export_package" USING btree ("tenant_id","professional_id") WHERE "export_package"."kind" = 'clinical';--> statement-breakpoint
CREATE INDEX "export_package_queued_idx" ON "export_package" USING btree ("tenant_id") WHERE "export_package"."status" = 'queued';
--> statement-breakpoint
ALTER TABLE "export_package" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "export_package" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "export_package" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- A package is never deleted, and the runtime role can only record the outcome of the build: it
-- cannot re-point a clinical package to another professional or turn it into an administrative one.
REVOKE DELETE, TRUNCATE ON "export_package" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE ON "export_package" FROM app_rw;
--> statement-breakpoint
GRANT UPDATE ("status", "object_key", "file_name", "size_bytes", "sha256", "entry_count", "built_at", "failure_code", "updated_at")
  ON "export_package" TO app_rw;
--> statement-breakpoint
-- The operator console can ask for the administrative package of the organization it cancels, and
-- see the state of the packages (never their file names or keys). Nothing else: it cannot write a
-- finished package, a clinical one, or point a package at an object.
GRANT SELECT ("id", "tenant_id", "kind", "status", "created_at", "built_at", "failure_code")
  ON "export_package" TO app_operator;
--> statement-breakpoint
GRANT INSERT ("tenant_id", "kind", "status") ON "export_package" TO app_operator;
--> statement-breakpoint
CREATE POLICY "operator_request_only" ON "export_package" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK ("kind" = 'administrative' AND "status" = 'queued' AND "professional_id" IS NULL);
