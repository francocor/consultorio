-- Judgment day, Stage 4, round 1 (findings C1 and C11): the guards of payments and reversals now take
-- the locks that make them true under concurrency. Both functions are replaced (the applied migration
-- 0414 is not edited).
--
-- C1. A close reads the entries of the register, writes the expected cash and moves the register to
-- `closed`; a payment or a refund that meets it must either be in that total or be refused. The guards
-- read the register with a plain SELECT, so a close that had not committed yet looked `open` to them,
-- and the foreign key (which waits for the close) let the row land in the closed register after the
-- total was written. The register is now read FOR SHARE: a close in progress (FOR UPDATE) makes the
-- entry wait, and once it commits the guard sees `closed` and refuses; an entry that is written first
-- keeps the close waiting until it commits, so the close counts it.
--
-- C11. A reversal names the payment AND the charge; nothing checked that the charge is the one of the
-- payment, and the sum of the earlier reversals was read without a lock, so two refunds of the same
-- payment could both pass. The application role has no UPDATE on `payment` (money is append only), so
-- the row of the payment cannot be locked by it (FOR UPDATE needs the UPDATE privilege). Reversals of
-- a payment are serialized on the row of its charge instead, the same lock the application takes first
-- (`lockCharge`), in the same order: charge, then register. FOR NO KEY UPDATE does not conflict with
-- the key share lock that the foreign key of a new payment takes on the charge.
CREATE OR REPLACE FUNCTION app.guard_payment() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    register record;
    state text;
  BEGIN
    IF NEW.cash_session_id IS NOT NULL THEN
      SELECT s.status, s.location_id INTO register
        FROM cash_session s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cash_session_id
        FOR SHARE;
      IF FOUND THEN
        IF register.status <> 'open' THEN
          RAISE EXCEPTION 'a closed cash register takes no new entries' USING ERRCODE = '42501';
        END IF;
        IF register.location_id <> NEW.location_id THEN
          RAISE EXCEPTION 'the cash register belongs to another location' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    SELECT c.status INTO state FROM charge c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.charge_id;
    IF state = 'voided' THEN
      RAISE EXCEPTION 'a voided charge takes no payment' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_payment_reversal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    original record;
    register record;
    already bigint;
  BEGIN
    SELECT p.amount_cents, p.method, p.charge_id INTO original
      FROM payment p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id;
    IF FOUND THEN
      IF NEW.charge_id IS DISTINCT FROM original.charge_id THEN
        RAISE EXCEPTION 'the charge of a reversal is the charge of its payment' USING ERRCODE = '23514';
      END IF;
      -- Serializes the reversals of one payment (and the payments of one charge) before the sum is read.
      PERFORM 1 FROM charge c
       WHERE c.tenant_id = NEW.tenant_id AND c.id = original.charge_id
       FOR NO KEY UPDATE;
      SELECT coalesce(sum(r.amount_cents), 0) INTO already
        FROM payment_reversal r WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = NEW.payment_id;
      IF already + NEW.amount_cents > original.amount_cents THEN
        RAISE EXCEPTION 'the reversals of a payment cannot exceed the payment' USING ERRCODE = '23514';
      END IF;
      IF original.method = 'cash' AND NEW.cash_session_id IS NULL THEN
        RAISE EXCEPTION 'the cash of a refund leaves an open cash register' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.cash_session_id IS NOT NULL THEN
      SELECT s.status, s.location_id INTO register
        FROM cash_session s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cash_session_id
        FOR SHARE;
      IF FOUND THEN
        IF register.status <> 'open' THEN
          RAISE EXCEPTION 'a closed cash register takes no new entries' USING ERRCODE = '42501';
        END IF;
        IF register.location_id <> NEW.location_id THEN
          RAISE EXCEPTION 'the cash register belongs to another location' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
