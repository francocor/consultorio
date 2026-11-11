-- Judgment day, Stage 4, round 2 (findings R2-1, R2-4 and R2-5). 0491 is applied and is not edited: the
-- functions are replaced here.
--
-- R2-1, the simulator. A lookup of a voucher says what the authority holds for it: the buyer's
-- document and, for a credit note, the voucher it cancels (the columns below), so the caller can tell
-- the voucher of an invoice from the voucher of another one that has the same total and the same date.
-- The rows that exist keep the columns empty (simulator vouchers only).
ALTER TABLE "local_afip_voucher" ADD COLUMN "buyer_doc_type" text;--> statement-breakpoint
ALTER TABLE "local_afip_voucher" ADD COLUMN "buyer_doc_number" text;--> statement-breakpoint
ALTER TABLE "local_afip_voucher" ADD COLUMN "assoc_type" text;--> statement-breakpoint
ALTER TABLE "local_afip_voucher" ADD COLUMN "assoc_point_of_sale" integer;--> statement-breakpoint
ALTER TABLE "local_afip_voucher" ADD COLUMN "assoc_number" integer;--> statement-breakpoint
-- R2-5, the order of the locks. The writers of invoices lock the charge (shared) and then its lines;
-- the void of a charge does the same with the charge FOR UPDATE. `guard_invoice_line_insert` locked the
-- line and then the charge, so a writer that reaches the table without the application (and the
-- application itself, for a credit note) could meet a void in the opposite order and deadlock. The
-- charge is now taken FOR SHARE BEFORE the line, in every branch. The application takes the same locks
-- first (`readChargeLines` with `lockCharges`, also for a credit note), so it is the same order and
-- the same locks again.
CREATE OR REPLACE FUNCTION app.guard_invoice_line_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    owner invoice%ROWTYPE;
    line_charge uuid;
    charge_state text;
    billed bigint;
    credited bigint;
  BEGIN
    SELECT * INTO owner FROM invoice WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF owner.created_at <> now() THEN
      RAISE EXCEPTION 'the lines of an invoice are written with it' USING ERRCODE = '42501';
    END IF;
    -- The charge first, then the line: the order of every writer. A void of the charge in progress
    -- makes the line wait here, holding nothing the void needs.
    PERFORM 1 FROM charge WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_id FOR SHARE;
    -- A statement of its own, before anything else is read: what follows sees what the other writers of
    -- this charge line committed.
    PERFORM 1 FROM charge_line WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_line_id FOR UPDATE;
    SELECT charge_id INTO line_charge FROM charge_line
     WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_line_id;
    IF FOUND AND line_charge IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'the charge of an invoice line is the charge of its charge line'
        USING ERRCODE = '23514';
    END IF;
    IF owner.credit_note_of_id IS NULL THEN
      SELECT status INTO charge_state FROM charge
       WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_id;
      IF charge_state = 'voided' THEN
        RAISE EXCEPTION 'a voided charge is not invoiced' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT amount_cents INTO billed FROM invoice_line
       WHERE tenant_id = NEW.tenant_id AND invoice_id = owner.credit_note_of_id
         AND charge_line_id = NEW.charge_line_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a credit note covers lines of the invoice it cancels' USING ERRCODE = '23514';
      END IF;
      SELECT coalesce(sum(il.amount_cents), 0) INTO credited
        FROM invoice_line il
        JOIN invoice note ON note.tenant_id = il.tenant_id AND note.id = il.invoice_id
       WHERE il.tenant_id = NEW.tenant_id AND note.credit_note_of_id = owner.credit_note_of_id
         AND il.charge_line_id = NEW.charge_line_id AND note.status <> 'rejected';
      IF credited + NEW.amount_cents > billed THEN
        RAISE EXCEPTION 'a credit note cannot credit more of a line than the invoice billed'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
-- R2-4, the environment of a point of sale. The application refuses the change once an invoice went
-- through the point of sale, but it reads the invoices without a lock: an invoice that is being
-- created in another transaction is invisible to it. Two pieces close the gap at the database:
--
-- - an invoice takes the row of its point of sale FOR SHARE when it is inserted, and keeps it to the
--   end of its transaction (`guard_invoice_insert`);
-- - the update of the environment waits for those transactions (an UPDATE needs the row exclusively),
--   and when its trigger runs, after the row is locked, it sees every invoice that committed.
CREATE OR REPLACE FUNCTION app.guard_invoice_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    original invoice%ROWTYPE;
    credited bigint;
    previous text;
    expected text;
  BEGIN
    -- Before anything else: the point of sale does not change its environment under this invoice.
    PERFORM 1 FROM point_of_sale
     WHERE tenant_id = NEW.tenant_id AND number = NEW.point_of_sale FOR SHARE;
    IF NEW.credit_note_of_id IS NOT NULL THEN
      -- The invoice being cancelled is locked (FOR NO KEY UPDATE does not conflict with the key share
      -- lock that the foreign key of the note takes), so the notes of one invoice go one at a time.
      SELECT * INTO original FROM invoice
       WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_of_id
       FOR NO KEY UPDATE;
      IF FOUND THEN
        IF original.status NOT IN ('issued', 'manual') OR original.credit_note_of_id IS NOT NULL THEN
          RAISE EXCEPTION 'only an issued or registered invoice is cancelled by a credit note'
            USING ERRCODE = '23514';
        END IF;
        expected := CASE original.type
          WHEN 'FA' THEN 'NCA' WHEN 'FB' THEN 'NCB' WHEN 'FC' THEN 'NCC' END;
        IF NEW.type IS DISTINCT FROM expected THEN
          RAISE EXCEPTION 'a credit note has the letter of the invoice it cancels'
            USING ERRCODE = '23514';
        END IF;
        SELECT coalesce(sum(total_cents), 0) INTO credited FROM invoice
         WHERE tenant_id = NEW.tenant_id AND credit_note_of_id = NEW.credit_note_of_id
           AND status <> 'rejected';
        IF credited + NEW.total_cents > original.total_cents THEN
          RAISE EXCEPTION 'the credit notes of an invoice cannot add up to more than the invoice'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
    IF NEW.previous_attempt_id IS NOT NULL THEN
      SELECT status INTO previous FROM invoice
       WHERE tenant_id = NEW.tenant_id AND id = NEW.previous_attempt_id;
      IF FOUND AND previous <> 'rejected' THEN
        RAISE EXCEPTION 'only a rejected attempt is retried' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE FUNCTION app.guard_point_of_sale_environment() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- The numbers of the other environment start again at 1: they would collide with the vouchers that
    -- exist. Runs with the row locked, so an invoice that was being created has committed or is seen.
    IF EXISTS (
      SELECT 1 FROM invoice WHERE tenant_id = OLD.tenant_id AND point_of_sale = OLD.number
    ) THEN
      RAISE EXCEPTION 'the environment of a point of sale does not change once invoices went through it'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER point_of_sale_environment_guard
  BEFORE UPDATE OF environment ON "point_of_sale"
  FOR EACH ROW WHEN (OLD.environment IS DISTINCT FROM NEW.environment)
  EXECUTE FUNCTION app.guard_point_of_sale_environment();
