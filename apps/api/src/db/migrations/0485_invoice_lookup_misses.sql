-- Judgment day, Stage 4, round 6 (suspect A-S1). `invoice.lookup_misses`: how many times in a row the
-- authority answered "no voucher" at a number at or below its own last one while an invoice waits. A
-- lookup may lag behind an authorization for a moment, so the invoice waits a few rounds before it is
-- parked for a person instead of being parked on the first miss. Zero outside a wait.
ALTER TABLE "invoice" ADD COLUMN "lookup_misses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_lookup_misses_check" CHECK ("invoice"."lookup_misses" >= 0);
