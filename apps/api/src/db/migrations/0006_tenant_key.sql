CREATE TABLE "tenant_key" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text DEFAULT 'tenant-dek' NOT NULL,
	"version" integer NOT NULL,
	"kek_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "tenant_key_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_key_tenant_id_purpose_version_key" UNIQUE("tenant_id","purpose","version"),
	CONSTRAINT "tenant_key_status_check" CHECK ("tenant_key"."status" in ('active', 'retired')),
	CONSTRAINT "tenant_key_version_check" CHECK ("tenant_key"."version" between 1 and 65535),
	CONSTRAINT "tenant_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_key_one_active_idx" ON "tenant_key" USING btree ("tenant_id","purpose") WHERE "tenant_key"."status" = 'active';
--> statement-breakpoint
ALTER TABLE "tenant_key" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_key" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_key" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Keys are never deleted: losing one would destroy the data it protects. Retiring is an UPDATE.
REVOKE DELETE, TRUNCATE ON "tenant_key" FROM app_rw;
