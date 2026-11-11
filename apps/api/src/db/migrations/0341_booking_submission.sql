-- Retention exception 4 (tenancy, "No deletion"): an unverified submission and a spent or expired
-- code are hard-deleted by the booking.purge job, so the application role keeps DELETE on these two
-- tables (and only these: test/policy/no-delete/booking.json). Nothing else of online booking is deleted.
CREATE TABLE "booking_submission" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"email" "citext" NOT NULL,
	"payload_enc" "bytea" NOT NULL,
	"hold_id" uuid,
	"purge_after" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"appointment_id" uuid,
	CONSTRAINT "booking_submission_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_submission_kind_check" CHECK ("booking_submission"."kind" in ('booking', 'waitlist_join')),
	CONSTRAINT "booking_submission_status_check" CHECK ("booking_submission"."status" in ('unverified', 'verified')),
	CONSTRAINT "booking_submission_verified_check" CHECK (("booking_submission"."status" = 'verified') = ("booking_submission"."verified_at" is not null)),
	CONSTRAINT "booking_submission_hold_check" CHECK (("booking_submission"."kind" = 'booking') = ("booking_submission"."hold_id" is not null)),
	CONSTRAINT "booking_submission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "booking_submission_hold_fkey" FOREIGN KEY ("tenant_id","hold_id") REFERENCES "public"."slot_hold"("tenant_id","id"),
	CONSTRAINT "booking_submission_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "otp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"email" "citext" NOT NULL,
	"submission_id" uuid,
	"code_hash" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "otp_challenge_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "otp_challenge_purpose_check" CHECK ("otp_challenge"."purpose" in ('booking', 'waitlist_join', 'portal_registration', 'portal_sign_in')),
	CONSTRAINT "otp_challenge_attempts_check" CHECK ("otp_challenge"."attempts" >= 0),
	CONSTRAINT "otp_challenge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_submission_fkey" FOREIGN KEY ("tenant_id","submission_id") REFERENCES "public"."booking_submission"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_submission_hold_key" ON "booking_submission" USING btree ("tenant_id","hold_id") WHERE "booking_submission"."hold_id" is not null;--> statement-breakpoint
CREATE INDEX "booking_submission_purge_idx" ON "booking_submission" USING btree ("purge_after") WHERE "booking_submission"."status" = 'unverified';--> statement-breakpoint
CREATE INDEX "booking_submission_email_idx" ON "booking_submission" USING btree ("tenant_id","email","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenge_email_idx" ON "otp_challenge" USING btree ("tenant_id","email","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenge_submission_idx" ON "otp_challenge" USING btree ("tenant_id","submission_id");--> statement-breakpoint
CREATE INDEX "otp_challenge_expiry_idx" ON "otp_challenge" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "booking_submission" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_submission" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_submission" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "otp_challenge" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "otp_challenge" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "otp_challenge" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
