CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"time_zone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "location_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "location_time_zone_check" CHECK ("location"."time_zone" ~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$')
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"read_only_since" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"billing_exempt" boolean DEFAULT false NOT NULL,
	"country" text DEFAULT 'AR' NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_key" UNIQUE("slug"),
	CONSTRAINT "tenant_slug_check" CHECK ("tenant"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'),
	CONSTRAINT "tenant_status_check" CHECK ("tenant"."status" in ('active', 'read_only', 'cancelled')),
	CONSTRAINT "tenant_read_only_since_check" CHECK ("tenant"."status" <> 'read_only' or "tenant"."read_only_since" is not null)
);
--> statement-breakpoint
CREATE TABLE "tenant_feature" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "tenant_feature_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_feature_tenant_id_feature_key" UNIQUE("tenant_id","feature")
);
--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_feature" ADD CONSTRAINT "tenant_feature_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- is_demo is set when the tenant is created and never changes: demo_reset and the adapter guard
-- trust it. A trigger, not application code, so no path (including SQL) can flip it.
CREATE FUNCTION app.reject_is_demo_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'tenant.is_demo is immutable';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER tenant_is_demo_immutable
  BEFORE UPDATE OF is_demo ON "tenant"
  FOR EACH ROW WHEN (OLD.is_demo IS DISTINCT FROM NEW.is_demo)
  EXECUTE FUNCTION app.reject_is_demo_change();
--> statement-breakpoint
-- Row level security. The tenant table is isolated by its own id.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant" USING ("id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "location" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "location" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "tenant_feature" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_feature" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_feature" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
