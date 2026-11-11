CREATE TABLE "inbound_message" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text NOT NULL,
	"from_hash" text NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "inbound_message_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inbound_message_tenant_id_event_id_key" UNIQUE("tenant_id","event_id"),
	CONSTRAINT "inbound_message_outcome_check" CHECK ("outcome" in ('confirmed', 'cancelled', 'opted_out', 'needs_review', 'ignored')),
	CONSTRAINT "inbound_message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "local_whatsapp_control" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'ok' NOT NULL,
	"unreachable_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_whatsapp_control_single_row_check" CHECK ("local_whatsapp_control"."id" = 1),
	CONSTRAINT "local_whatsapp_control_mode_check" CHECK ("mode" in ('ok', 'down', 'reject_template'))
);
--> statement-breakpoint
CREATE TABLE "local_whatsapp_message" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"provider_message_id" text NOT NULL,
	"idempotency_key" text,
	"direction" text NOT NULL,
	"number" text NOT NULL,
	"template_key" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_whatsapp_message_direction_check" CHECK ("local_whatsapp_message"."direction" in ('outbound', 'inbound')),
	CONSTRAINT "local_whatsapp_message_status_check" CHECK ("status" in ('accepted', 'sent', 'delivered', 'read', 'failed', 'received'))
);
--> statement-breakpoint
CREATE TABLE "message_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "message_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_event_tenant_id_event_id_key" UNIQUE("tenant_id","event_id"),
	CONSTRAINT "message_event_status_check" CHECK ("status" in ('sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "message_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "message_event_message_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."message"("tenant_id","id")
);
--> statement-breakpoint
-- The list of failure reasons gains one (a superset, so no existing row can break it). NOT VALID skips the
-- scan of a table that has row level security forced and no tenant in a migration; new rows are checked.
ALTER TABLE "message" DROP CONSTRAINT "message_failure_reason_check";--> statement-breakpoint
CREATE UNIQUE INDEX "local_whatsapp_message_provider_id_key" ON "local_whatsapp_message" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_whatsapp_message_idempotency_key" ON "local_whatsapp_message" USING btree ("idempotency_key") WHERE "local_whatsapp_message"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "local_whatsapp_message_created_idx" ON "local_whatsapp_message" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_failure_reason_check" CHECK (("status" = 'failed') = ("failure_reason" is not null) and ("failure_reason" is null or "failure_reason" in ('not_on_whatsapp', 'template_rejected', 'invalid_number', 'mailbox_unavailable', 'delivery_failed', 'retries_exhausted'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "message_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_event" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "inbound_message" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inbound_message" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_message" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The WhatsApp webhook knows a provider id or a sender, not a tenant (the tenant never comes from the
-- request). Two extra read-only policies, in the pattern of the host lookup (migration 0003), let one
-- transaction read the messages with the provider id, or to the sender, that it declares in a
-- transaction-local setting. With the setting unset they match nothing, so every other query is as
-- isolated as before; the lookup selects the tenant id only.
CREATE POLICY "message_provider_lookup" ON "message" FOR SELECT
  USING ("provider_message_id" = nullif(current_setting('app.lookup_provider_message_id', true), ''));
--> statement-breakpoint
CREATE POLICY "message_recipient_lookup" ON "message" FOR SELECT
  USING ("channel" = 'whatsapp' AND "address_hash" = nullif(current_setting('app.lookup_recipient_hash', true), ''));
--> statement-breakpoint
-- Events and replies are history, and the simulator's phone keeps what it was given.
REVOKE DELETE, TRUNCATE ON "message_event" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "inbound_message" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "local_whatsapp_message" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "local_whatsapp_control" FROM app_rw;
