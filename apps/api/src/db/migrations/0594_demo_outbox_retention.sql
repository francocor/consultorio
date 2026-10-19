-- Judgment day, Stage 5, round 1 (JD-S5 R1, A-S): the demo outbox (0590) had no retention. The rows are
-- the fictitious email a demo organization "sent", read in the provider console; they are useless a
-- day later, and a demo that is not reset would keep them for good. The runtime role has no DELETE on
-- the table (nothing updates or deletes a row), so the purge is a definer function that removes only
-- what is older than the cutoff it is given, and never anything younger than an hour: a caller cannot
-- use it to empty the outbox of a demo that is being walked through. The worker calls it every hour
-- with a cutoff of 24 hours.
CREATE FUNCTION app.demo_outbox_purge(p_older_than timestamp with time zone) RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    WITH removed AS (
      DELETE FROM public.demo_outbox
       WHERE created_at < LEAST(p_older_than, now() - interval '1 hour')
      RETURNING 1
    )
    SELECT count(*)::integer FROM removed
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.demo_outbox_purge(timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.demo_outbox_purge(timestamp with time zone) TO app_rw;
