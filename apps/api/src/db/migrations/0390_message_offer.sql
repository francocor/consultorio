CREATE TABLE "message_offer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"url" text,
	CONSTRAINT "message_offer_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_offer_tenant_id_message_id_key" UNIQUE("tenant_id","message_id"),
	CONSTRAINT "message_offer_window_check" CHECK ("message_offer"."starts_at" < "message_offer"."ends_at"),
	CONSTRAINT "message_offer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "message_offer_message_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."message"("tenant_id","id"),
	CONSTRAINT "message_offer_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_cancel_reason_check";--> statement-breakpoint
CREATE INDEX "message_offer_url_idx" ON "message_offer" USING btree ("tenant_id","expires_at") WHERE "message_offer"."url" is not null;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_cancel_reason_check" CHECK (("status" = 'cancelled') = ("cancel_reason" is not null) and ("cancel_reason" is null or "cancel_reason" in ('tenant_read_only', 'demo_tenant', 'opted_out', 'appointment_changed', 'appointment_cancelled', 'appointment_over', 'integration_off', 'quota_exhausted', 'no_channel', 'offer_expired')));
--> statement-breakpoint
ALTER TABLE "message_offer" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_offer" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_offer" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The link is cleared when the offer expires; the row itself stays with its message.
REVOKE DELETE, TRUNCATE ON "message_offer" FROM app_rw;
