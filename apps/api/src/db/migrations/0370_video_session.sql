CREATE TABLE "video_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"status" text DEFAULT 'link_pending' NOT NULL,
	"pending_reason" text,
	"close_reason" text,
	"provider" text,
	"manual_link" text,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "video_session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "video_session_appointment_key" UNIQUE("tenant_id","appointment_id"),
	CONSTRAINT "video_session_status_check" CHECK ("video_session"."status" in ('ready', 'link_pending', 'closed')),
	CONSTRAINT "video_session_pending_reason_check" CHECK ("video_session"."pending_reason" is null or "video_session"."pending_reason" in ('creating', 'integration_off', 'provider_unavailable', 'provider_failed')),
	CONSTRAINT "video_session_close_reason_check" CHECK ("video_session"."close_reason" is null or "video_session"."close_reason" in ('cancelled', 'no_show', 'attended', 'in_person')),
	CONSTRAINT "video_session_reason_matches_status_check" CHECK (("video_session"."status" = 'link_pending') = ("video_session"."pending_reason" is not null)
        and ("video_session"."status" = 'closed') = ("video_session"."close_reason" is not null)),
	CONSTRAINT "video_session_opened_order_check" CHECK ("video_session"."last_opened_at" is null
        or ("video_session"."first_opened_at" is not null and "video_session"."last_opened_at" >= "video_session"."first_opened_at")),
	CONSTRAINT "video_session_manual_link_check" CHECK ("video_session"."manual_link" is null or length("video_session"."manual_link") <= 2048),
	CONSTRAINT "video_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "video_session_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "video_session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "video_session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "video_session" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- A video session ends by closing, never by deleting: the audit trail and the attendance
-- information of the appointment point at it.
REVOKE DELETE, TRUNCATE ON "video_session" FROM app_rw;
