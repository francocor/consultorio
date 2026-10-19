-- Judgment day, Stage 4, round 1 (findings C2 and C6): the guards and the refresh of the invoices of
-- migration 0444 now take the locks they need to be true under concurrency. The functions are replaced
-- (0444 is applied and is not edited).
--
-- C6, lost update. `refresh_invoiced` was one UPDATE whose SET subquery sums the lines of the charge
-- line. When a second writer waited for the row lock, Postgres re-checked the WHERE of the UPDATE on
-- the new row version, but the subquery kept the snapshot of the start of the statement: the first
-- writer's lines were not in the sum and its amount was overwritten. The row is now locked by a
-- statement of its own, and the UPDATE that follows takes a fresh snapshot, taken after the lock, so it
-- sees everything that was committed. The same lock opens `guard_invoice_line_insert`, so what the guard
-- reads of the other credit notes of a line is current too. The credit note guard of the invoice
-- (`guard_invoice_insert`) locks the invoice being cancelled, so two notes racing for the balance of an
-- invoice are serialized and the second one sees the first.
--
-- C2, a voided charge. A line is refused when the charge it names is voided (credit notes are exempt:
-- they cancel what an issued invoice billed, and a charge with an invoice standing over it cannot be
-- voided). The charge is read FOR SHARE, so a void in progress makes the line wait and then see it. The
-- application takes the same lock first (`lockLines`), in the order charge, then lines, the order the
-- void follows too.
CREATE OR REPLACE FUNCTION app.refresh_invoiced(p_tenant uuid, p_line uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- A statement of its own: the UPDATE below starts after the lock is held and reads current data.
    PERFORM 1 FROM charge_line WHERE tenant_id = p_tenant AND id = p_line FOR UPDATE;
    UPDATE charge_line SET invoiced_cents = (
      SELECT coalesce(sum(CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN -il.amount_cents
                               ELSE il.amount_cents END), 0)
        FROM invoice_line il
        JOIN invoice i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
       WHERE il.tenant_id = p_tenant AND il.charge_line_id = p_line
         AND CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN i.status = 'issued'
                  ELSE i.status IN ('pending', 'issued', 'manual') END
    )
    WHERE tenant_id = p_tenant AND id = p_line;
  END
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_invoice_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    original invoice%ROWTYPE;
    credited bigint;
    previous text;
    expected text;
  BEGIN
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
    -- A statement of its own, before anything is read: what follows sees what the other writers of
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
       WHERE tenant_id = NEW.tenant_id AND id = NEW.charge_id
       FOR SHARE;
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
