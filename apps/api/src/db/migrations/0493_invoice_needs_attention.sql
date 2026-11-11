-- Judgment day, Stage 4, round 1 (finding C8): a pending invoice whose voucher the authority issued
-- under a number we already hold is parked as `needs_attention` instead of being retried forever. The
-- new value is a superset of the old ones, so the rows that exist satisfy the check; it is stated
-- NOT VALID, like every constraint added to a table that may be large, and `runMigrations` validates
-- it right after the migrator (docs/migration-ranges.md).
ALTER TABLE "invoice" DROP CONSTRAINT "invoice_delivery_state_check";--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_delivery_state_check" CHECK (("status" = 'pending') = ("delivery_state" is not null) and ("delivery_state" is null or "delivery_state" in ('queued', 'retrying', 'awaiting_reconciliation', 'needs_attention'))) NOT VALID;
