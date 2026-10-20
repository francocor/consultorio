-- The retry of the verification email (Stage 6, S6.02, task 6.10). A signup is saved even when the
-- email provider is down; the worker looks for the signups whose email never went out and sends it
-- again, with a backoff. The signups of every organization are listed by one function that returns
-- organization ids and nothing else (no address, no name), so the worker needs no cross-tenant read
-- of its own. Only an unconfirmed signup that has not been sent and has not used its five automatic
-- attempts is listed, and not before the backoff of its last attempt is over (one, two, four, eight
-- and sixteen minutes), so a request that is still sending its first email is never raced.
CREATE FUNCTION app.signup_unsent(p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.tenant_id
    FROM public.signup_pending p
   WHERE p.verified_at IS NULL
     AND p.verification_sent_at IS NULL
     AND p.send_attempts < 5
     AND coalesce(p.last_send_attempt_at, p.created_at)
           < now() - make_interval(secs => 60 * power(2, p.send_attempts)::integer)
   ORDER BY p.created_at
   LIMIT greatest(least(p_limit, 100), 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.signup_unsent(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.signup_unsent(integer) TO app_rw;
