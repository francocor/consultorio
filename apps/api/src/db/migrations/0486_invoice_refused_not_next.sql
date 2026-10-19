-- Judgment day, Stage 4, round 7 (finding R7-1). `invoice.refused_not_next`: how many requests in a row
-- the authority refused with `not_next` while its last number did not move. ARCA error 10016 also covers
-- a date earlier than the last authorized voucher, which waiting never cures: after a few refusals the
-- invoice is parked with its own reason instead of being sent again for ever. Zero outside a streak.
-- Stage 4 is not deployed, so no data fix is written. 0480 to 0485 are not edited.
ALTER TABLE "invoice" ADD COLUMN "refused_not_next" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_refused_not_next_check" CHECK ("invoice"."refused_not_next" >= 0);