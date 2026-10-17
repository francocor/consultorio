CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointment_id" uuid,
	"patient_id" uuid NOT NULL,
	"professional_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_reason" text,
	"failure_reason" text,
	"provider_message_id" text,
	"dedupe_key" text NOT NULL,
	"address_hash" text,
	"planned_starts_at" timestamp with time zone,
	"appointment_version" integer,
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"trigger" text DEFAULT 'automatic' NOT NULL,
	CONSTRAINT "message_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_tenant_id_dedupe_key_key" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "message_kind_check" CHECK ("kind" in ('reminder', 'confirmation', 'waitlist_offer', 'otp_code', 'invitation', 'password_reset', 'portal_notice', 'consent_request', 'invoice', 'subscription_notice')),
	CONSTRAINT "message_channel_check" CHECK ("channel" in ('email', 'whatsapp')),
	CONSTRAINT "message_status_check" CHECK ("status" in ('queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
	CONSTRAINT "message_whatsapp_kind_check" CHECK ("channel" = 'email' or "kind" in ('reminder', 'confirmation', 'waitlist_offer')),
	CONSTRAINT "message_cancel_reason_check" CHECK (("status" = 'cancelled') = ("cancel_reason" is not null) and ("cancel_reason" is null or "cancel_reason" in ('tenant_read_only', 'demo_tenant', 'opted_out', 'appointment_changed', 'appointment_cancelled', 'appointment_over', 'integration_off', 'quota_exhausted', 'no_channel'))),
	CONSTRAINT "message_failure_reason_check" CHECK (("status" = 'failed') = ("failure_reason" is not null) and ("failure_reason" is null or "failure_reason" in ('not_on_whatsapp', 'template_rejected', 'invalid_number', 'mailbox_unavailable', 'retries_exhausted'))),
	CONSTRAINT "message_trigger_check" CHECK ("trigger" in ('automatic', 'manual')),
	CONSTRAINT "message_attempts_check" CHECK ("message"."attempts" >= 0),
	CONSTRAINT "message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "message_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "message_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id"),
	CONSTRAINT "message_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "message_attempt" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt_no" smallint NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	CONSTRAINT "message_attempt_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_attempt_tenant_id_message_id_attempt_no_key" UNIQUE("tenant_id","message_id","attempt_no"),
	CONSTRAINT "message_attempt_outcome_check" CHECK ("outcome" in ('started', 'accepted', 'retryable', 'rejected', 'error')),
	CONSTRAINT "message_attempt_no_check" CHECK ("message_attempt"."attempt_no" >= 1),
	CONSTRAINT "message_attempt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "message_attempt" ADD CONSTRAINT "message_attempt_message_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."message"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_provider_message_id_key" ON "message" USING btree ("provider_message_id") WHERE "message"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "message_appointment_idx" ON "message" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "message_patient_idx" ON "message" USING btree ("tenant_id","patient_id","channel");--> statement-breakpoint
CREATE INDEX "message_queue_idx" ON "message" USING btree ("tenant_id","send_at") WHERE "message"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "message_address_idx" ON "message" USING btree ("tenant_id","channel","address_hash") WHERE "message"."address_hash" is not null;
--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "message_attempt" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_attempt" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_attempt" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- A message is cancelled or failed, never deleted; its attempts are the history of how it went (notifications, "Delivery tracking").
REVOKE DELETE, TRUNCATE ON "message" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "message_attempt" FROM app_rw;
