CREATE TABLE "channel_preference" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"recorded_by" uuid,
	CONSTRAINT "channel_preference_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_preference_channel_check" CHECK ("channel" in ('email', 'whatsapp')),
	CONSTRAINT "channel_preference_state_source_check" CHECK (("state" = 'opted_in' and "source" in ('online_booking', 'staff', 'patient_email_link')) or ("state" = 'opted_out' and "source" in ('whatsapp_keyword', 'email_link', 'staff'))),
	CONSTRAINT "channel_preference_staff_check" CHECK (("channel_preference"."source" = 'staff') = ("channel_preference"."recorded_by" is not null)),
	CONSTRAINT "channel_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "channel_preference_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "channel_preference_current_idx" ON "channel_preference" USING btree ("tenant_id","patient_id","channel","created_at");
--> statement-breakpoint
ALTER TABLE "channel_preference" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "channel_preference" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_preference" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The choices of a patient are a history: nothing is changed or removed, so who recorded what and when
-- survives (notifications, "Opt-out and consent").
REVOKE UPDATE, DELETE, TRUNCATE ON "channel_preference" FROM app_rw;
