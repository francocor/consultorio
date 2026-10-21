-- Stage 6, judgment day round 1 (signup and retention), JD-S6 R1-S6-2: the operator cannot cancel an
-- organization that has a subscription.
--
-- `app.operator_cancel_tenant` (0651) ended an organization with one UPDATE of its status. For an
-- organization that is billed that leaves the preapproval authorized at the provider and charging, and
-- nothing in the subscription says the end happened, so the next event of the subscription (the end of
-- a trial, a dunning step) could move the organization back. The end of a billed organization goes
-- through the subscription (its own cancellation, which cancels at the provider first), so this
-- function now refuses it: it is for an organization nobody bills (provisioned by the operator, or a
-- deployment without billing).
--
-- It also refuses an organization other than the one of the transaction. Row level security already
-- hid the others from it; saying so out loud makes the guarantee part of the function.
CREATE OR REPLACE FUNCTION app.operator_cancel_tenant(p_tenant uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_status text;
    v_demo boolean;
  BEGIN
    IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
      RETURN 'unknown';
    END IF;
    SELECT t.status, t.is_demo INTO v_status, v_demo
      FROM public.tenant t
     WHERE t.id = p_tenant
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'unknown';
    END IF;
    IF v_demo THEN
      RETURN 'demo';
    END IF;
    IF v_status = 'cancelled' THEN
      RETURN 'already';
    END IF;
    IF v_status NOT IN ('active', 'read_only') THEN
      RETURN 'not_cancellable';
    END IF;
    IF EXISTS (SELECT 1 FROM public.subscription s WHERE s.tenant_id = p_tenant) THEN
      RETURN 'has_subscription';
    END IF;
    UPDATE public.tenant SET status = 'cancelled', updated_at = now() WHERE id = p_tenant;
    RETURN 'cancelled';
  END
  $$;
