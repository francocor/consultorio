CREATE TABLE "membership_location" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "membership_location_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "membership_location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "membership_location_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id"),
	CONSTRAINT "membership_location_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "permission_grant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "permission_grant_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "permission_grant_not_clinical_check" CHECK ("permission_grant"."permission" not like 'clinical.%'),
	CONSTRAINT "permission_grant_format_check" CHECK ("permission_grant"."permission" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "permission_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "permission_grant_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "membership_location_live_idx" ON "membership_location" USING btree ("tenant_id","membership_id","location_id") WHERE "membership_location"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "membership_location_location_idx" ON "membership_location" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grant_live_idx" ON "permission_grant" USING btree ("tenant_id","membership_id","permission") WHERE "permission_grant"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "permission_grant_membership_idx" ON "permission_grant" USING btree ("tenant_id","membership_id");
--> statement-breakpoint
ALTER TABLE "permission_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "permission_grant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "permission_grant" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "membership_location" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_location" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_location" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
