-- Judgment day, Stage 6, round 1 (JD-S6 R1, S6-2): a cancelled organization stays cancelled. The
-- state machine of the subscription derives `tenant.status` from the subscription, and a trial end or
-- a dunning step that ran after the operator had cancelled the organization (the subscription was
-- still `active` or `past_due`) wrote `active` or `read_only` over `cancelled` and gave the
-- organization back to a clinic whose records the retention flow had already started to archive.
-- The application checks it too (`syncTenantStatus`, the clocks); this is the backstop that no code
-- path, present or future, can walk around. Nothing leaves `cancelled`: the data of a cancelled
-- organization is exported, archived and erased, never reopened.
-- Error code: 23000 the rule "a cancelled organization is never reopened".
CREATE FUNCTION app.tenant_cancelled_is_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'a cancelled organization is never reopened' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER tenant_cancelled_is_terminal BEFORE UPDATE OF status ON "tenant"
  FOR EACH ROW EXECUTE FUNCTION app.tenant_cancelled_is_terminal();
