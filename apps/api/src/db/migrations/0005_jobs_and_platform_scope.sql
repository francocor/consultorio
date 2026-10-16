CREATE TABLE "job_execution" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queue" text NOT NULL,
	"job_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_execution_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_execution_tenant_id_queue_job_id_key" UNIQUE("tenant_id","queue","job_id"),
	-- Inline on purpose: drizzle-kit emits "ALTER TABLE ... ADD CONSTRAINT", and validating that
	-- against "tenant" (FORCE row level security, owner included) needs a tenant context that a
	-- migration does not have. A foreign key declared in CREATE TABLE skips the validation scan.
	CONSTRAINT "job_execution_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "occurred_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "job_execution" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_execution" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_execution" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Platform scope: jobs that fan out over every tenant (audit sealing, nightly verification) must
-- list tenant ids before they can set a tenant context. The tenant table is isolated by its own
-- id, so a second permissive policy lets a transaction that declares app.scope = 'platform' read
-- tenants. Like the host lookup policy, this is a safety net against forgotten filters, not a
-- defence against someone who already holds the application's database credentials.
CREATE POLICY "tenant_platform_scan" ON "tenant" FOR SELECT
  USING (current_setting('app.scope', true) = 'platform');
--> statement-breakpoint
-- pg-boss keeps its queue tables in their own schema. The schema and the tables are installed by
-- the owner (db:migrate runs pg-boss' own installer, see platform/jobs/install.ts); here the
-- runtime role is only given what it needs to enqueue and to work jobs.
CREATE SCHEMA IF NOT EXISTS pgboss;
--> statement-breakpoint
GRANT USAGE ON SCHEMA pgboss TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO app_rw;
