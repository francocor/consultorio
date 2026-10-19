-- Judgment day, Stage 4, round 4 (findings R4-1, R4-3 and the suspect B-S1). Two changes:
--
-- - the reasons a stray voucher is remembered for gain two values: `unmatched` (a voucher that exists
--   and that no invoice can record: the foreign voucher a lookup found, or the one that collided with a
--   number or a CAE we hold) and `parked_unknown` (the number a parked invoice expected, where its own
--   voucher may sit). The reasons that are certain (`orphaned`, `unmatched`) and the ones that are not
--   (`replaced_unresolved`, `parked_unknown`) are told apart by the application. 0480 is replaced, never
--   edited: the check is dropped and added again with the new list. Nothing deployed holds a row of the
--   table yet (Stage 4 is not deployed), and the new list contains the old one.
-- - `invoice.awaiting_since`: when the invoice began to wait for reconciliation. A series that stalls is
--   measured from there (the attempts also count the probes that other invoices bring forward). It is
--   nullable and mutable; the guard of the invoices lets a pending invoice move it.
ALTER TABLE "invoice_stray_voucher" DROP CONSTRAINT "invoice_stray_voucher_reason_check";--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "awaiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_stray_voucher" ADD CONSTRAINT "invoice_stray_voucher_reason_check" CHECK ("invoice_stray_voucher"."reason" in ('replaced_unresolved', 'orphaned', 'unmatched', 'parked_unknown'));