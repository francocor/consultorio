-- Judgment day, Stage 4, round 1 (findings C3 and C8): the worklist takes a new kind of item,
-- `invoice_attention`, whose subject is an invoice: a voucher the authority issued that the system
-- could not record (a number we already hold, or an invoice closed while its request was in flight).
-- Both checks only get a value, so the rows that exist satisfy them; they are stated NOT VALID, like
-- every constraint added to a table that may be large, and `runMigrations` validates them right after
-- the migrator (docs/migration-ranges.md).
ALTER TABLE "worklist_item" DROP CONSTRAINT "worklist_item_kind_check";--> statement-breakpoint
ALTER TABLE "worklist_item" DROP CONSTRAINT "worklist_item_subject_type_check";--> statement-breakpoint
ALTER TABLE "worklist_item" ADD CONSTRAINT "worklist_item_kind_check" CHECK ("kind" in ('pending_approval', 'identity_review', 'reminder_not_sent', 'reminder_not_delivered', 'reply_to_review', 'waitlist_manual_contact', 'invoice_attention')) NOT VALID;--> statement-breakpoint
ALTER TABLE "worklist_item" ADD CONSTRAINT "worklist_item_subject_type_check" CHECK ("worklist_item"."subject_type" in ('appointment', 'waitlist_entry', 'inbound_message', 'invoice')) NOT VALID;
