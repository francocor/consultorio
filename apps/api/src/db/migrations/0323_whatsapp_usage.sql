CREATE TABLE "whatsapp_usage_alert" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid NOT NULL,
	"period" text NOT NULL,
	"threshold" smallint NOT NULL,
	CONSTRAINT "whatsapp_usage_alert_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "whatsapp_usage_alert_key" UNIQUE("tenant_id","professional_id","period","threshold"),
	CONSTRAINT "whatsapp_usage_alert_threshold_check" CHECK ("whatsapp_usage_alert"."threshold" in (80, 100)),
	CONSTRAINT "whatsapp_usage_alert_period_check" CHECK ("whatsapp_usage_alert"."period" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "whatsapp_usage_alert_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "whatsapp_usage_alert_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_usage_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period" text NOT NULL,
	CONSTRAINT "whatsapp_usage_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "whatsapp_usage_event_tenant_id_message_id_key" UNIQUE("tenant_id","message_id"),
	CONSTRAINT "whatsapp_usage_event_period_check" CHECK ("whatsapp_usage_event"."period" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "whatsapp_usage_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "whatsapp_usage_event_message_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."message"("tenant_id","id"),
	CONSTRAINT "whatsapp_usage_event_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "whatsapp_usage_event_professional_idx" ON "whatsapp_usage_event" USING btree ("tenant_id","professional_id","period");
--> statement-breakpoint
ALTER TABLE "whatsapp_usage_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "whatsapp_usage_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "whatsapp_usage_event" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "whatsapp_usage_alert" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "whatsapp_usage_alert" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "whatsapp_usage_alert" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Usage is the record of the quota and of the bill: counted once, never changed, never removed.
REVOKE UPDATE, DELETE, TRUNCATE ON "whatsapp_usage_event" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "whatsapp_usage_alert" FROM app_rw;
