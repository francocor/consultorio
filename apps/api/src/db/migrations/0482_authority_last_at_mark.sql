-- Judgment day, Stage 4, round 5 (finding R5-1). `invoice.authority_last_at_mark`: the last number the
-- AUTHORITY had authorized in the series (its own answer, FECompUltimoAutorizado) when an invoice was
-- marked as waiting. Reconciling asks the authority for its last number again and looks at the numbers
-- between the two, instead of inferring the authority's count from the vouchers recorded here (an
-- out-of-band manual voucher, or a mistyped high number, defeated that inference). Nullable and
-- mutable (a pending invoice moves it; the first mark of a wait fixes it); null for an invoice marked
-- before this column existed, which is parked with its outcome unknown instead of guessed. Stage 4 is
-- not deployed, so only development data can be in that state. 0480 and 0481 are not edited.
ALTER TABLE "invoice" ADD COLUMN "authority_last_at_mark" bigint;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_authority_last_check" CHECK ("invoice"."authority_last_at_mark" is null or "invoice"."authority_last_at_mark" >= 0);