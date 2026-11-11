CREATE TABLE "public_hold" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hold_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"booking_link_id" uuid NOT NULL,
	CONSTRAINT "public_hold_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "public_hold_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "public_hold_hold_fkey" FOREIGN KEY ("tenant_id","hold_id") REFERENCES "public"."slot_hold"("tenant_id","id"),
	CONSTRAINT "public_hold_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id"),
	CONSTRAINT "public_hold_link_fkey" FOREIGN KEY ("tenant_id","booking_link_id") REFERENCES "public"."booking_link"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "public_hold_hold_key" ON "public_hold" USING btree ("tenant_id","hold_id");
--> statement-breakpoint
ALTER TABLE "public_hold" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public_hold" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public_hold" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- Never deleted, like the hold it describes (tenancy, "No deletion").
REVOKE DELETE, TRUNCATE ON "public_hold" FROM app_rw;
