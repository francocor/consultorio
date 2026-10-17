-- A password change or reset must end the user's sessions in EVERY organization, but `session` is
-- isolated by tenant: one transaction only sees the sessions of its own tenant. This function runs
-- as the owner (SECURITY DEFINER) to reach the others, and only for the user the transaction is
-- acting as (app.user_id), so it cannot be used to end someone else's sessions.
CREATE POLICY "session_revoke_everywhere" ON "session" FOR ALL TO app_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION app.revoke_user_sessions(p_user_id uuid, p_reason text, p_at timestamp with time zone, p_except uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'sessions can only be revoked for the acting user' USING ERRCODE = '42501';
  END IF;

  UPDATE public.session
     SET revoked_at = p_at, revoked_reason = p_reason, updated_at = p_at
   WHERE user_id = p_user_id
     AND revoked_at IS NULL
     AND (p_except IS NULL OR id <> p_except);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.revoke_user_sessions(uuid, text, timestamp with time zone, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.revoke_user_sessions(uuid, text, timestamp with time zone, uuid) TO app_rw;
