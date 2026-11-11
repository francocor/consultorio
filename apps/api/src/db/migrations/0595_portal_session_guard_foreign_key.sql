-- JD-S5 R1: the guard of a portal session refused a link that does not exist in the organization with
-- an error of its own (23000), ahead of the composite foreign key (23503) that already says it. The
-- guard now speaks only about a link that exists in the organization and belongs to another identity;
-- a link of another organization, or none, is left to the foreign key.
CREATE OR REPLACE FUNCTION app.portal_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.portal_identity_id IS DISTINCT FROM OLD.portal_identity_id
         OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
        RAISE EXCEPTION 'the identity and the token of a portal session never change' USING ERRCODE = '23000';
      END IF;
      IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'an ended portal session stays ended' USING ERRCODE = '23000';
      END IF;
    END IF;
    IF NEW.selected_link_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.selected_link_id IS DISTINCT FROM OLD.selected_link_id) THEN
      IF EXISTS (
        SELECT 1 FROM public.portal_link l
         WHERE l.tenant_id = NEW.tenant_id
           AND l.id = NEW.selected_link_id
           AND l.portal_identity_id IS DISTINCT FROM NEW.portal_identity_id
      ) THEN
        RAISE EXCEPTION 'a portal session reads only the links of its own identity' USING ERRCODE = '23000';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
