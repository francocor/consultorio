CREATE TABLE "booking_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid,
	"slug" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"regenerated_at" timestamp with time zone,
	CONSTRAINT "booking_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_link_slug_check" CHECK ("booking_link"."slug" ~ '^[a-z0-9]{8,32}$'),
	CONSTRAINT "booking_link_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "booking_link_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "booking_link_slug_key" ON "booking_link" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_link_organization_key" ON "booking_link" USING btree ("tenant_id") WHERE "booking_link"."professional_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_link_professional_key" ON "booking_link" USING btree ("tenant_id","professional_id") WHERE "booking_link"."professional_id" is not null;
--> statement-breakpoint
ALTER TABLE "booking_link" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_link" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_link" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- A link is disabled or regenerated (a new slug), never deleted (tenancy, "No deletion").
REVOKE DELETE, TRUNCATE ON "booking_link" FROM app_rw;
