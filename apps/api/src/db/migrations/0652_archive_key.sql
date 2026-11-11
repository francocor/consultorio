CREATE TABLE "archive_key" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"algorithm" text DEFAULT 'rsa-oaep-3072-sha256' NOT NULL,
	"public_key" "bytea" NOT NULL,
	"public_key_sha256" text NOT NULL,
	"wrapped_private_key" "bytea" NOT NULL,
	CONSTRAINT "archive_key_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "archive_key_tenant_id_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "archive_key_version_check" CHECK ("archive_key"."version" >= 1),
	CONSTRAINT "archive_key_algorithm_check" CHECK ("archive_key"."algorithm" = 'rsa-oaep-3072-sha256'),
	CONSTRAINT "archive_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "archive_key" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "archive_key" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "archive_key" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- A key never changes and is never deleted: the runtime role writes a version once and reads it. The
-- wrapped private key is opaque without the releaser's key, but nothing needs to rewrite it either.
REVOKE UPDATE, DELETE, TRUNCATE ON "archive_key" FROM app_rw;
