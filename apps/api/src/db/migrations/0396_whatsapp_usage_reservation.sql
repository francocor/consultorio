ALTER TABLE "whatsapp_usage_event" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_usage_event" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
-- The record of the quota and of the bill stays immutable (0323 revoked UPDATE), except for the two marks
-- of a reservation (and the stamp that says when): a place is confirmed when the provider accepts the message and released when it does
-- not carry it. Column privileges leave every other column as it was.
GRANT UPDATE ("confirmed_at", "released_at", "updated_at") ON "whatsapp_usage_event" TO app_rw;
