-- Stage 3, E integration: message_checks_not_valid (judgment day finding C14).
--
-- Migrations 0390 and 0391 re-added three CHECK constraints of "message" already validated, which
-- scans the whole table under a lock that stops writers, on a table with row level security forced
-- and, in production, a lot of rows. Migration 0322 had used NOT VALID for the same table, and this
-- states these three the same way: new rows are checked from the first statement, and the existing
-- ones are checked afterwards by VALIDATE CONSTRAINT, which takes a lock that lets reads and writes
-- go on. The definitions are the ones in force (0391); nothing about them changes.
ALTER TABLE "message" DROP CONSTRAINT "message_kind_check";
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_whatsapp_kind_check";
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_cancel_reason_check";
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_kind_check" CHECK ("kind" in ('reminder', 'confirmation', 'waitlist_offer', 'video_link', 'otp_code', 'invitation', 'password_reset', 'portal_notice', 'consent_request', 'invoice', 'subscription_notice')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_whatsapp_kind_check" CHECK ("channel" = 'email' or "kind" in ('reminder', 'confirmation', 'waitlist_offer', 'video_link')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_cancel_reason_check" CHECK (("status" = 'cancelled') = ("cancel_reason" is not null) and ("cancel_reason" is null or "cancel_reason" in ('tenant_read_only', 'demo_tenant', 'opted_out', 'appointment_changed', 'appointment_cancelled', 'appointment_over', 'integration_off', 'quota_exhausted', 'no_channel', 'offer_expired', 'video_link_unavailable'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "message" VALIDATE CONSTRAINT "message_kind_check";
--> statement-breakpoint
ALTER TABLE "message" VALIDATE CONSTRAINT "message_whatsapp_kind_check";
--> statement-breakpoint
ALTER TABLE "message" VALIDATE CONSTRAINT "message_cancel_reason_check";
