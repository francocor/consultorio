-- Judgment day, Stage 6, round 1 (JD-S6 R1, S6-9): `subscription_event` records one row per notice of
-- the payments provider, so that the same delivery finds its row and queues nothing a second time.
-- The id of the row is now derived from what the provider signed (the request id, the resource and
-- the time), so a replay is told from a new delivery, and the table would grow for ever: a notice is
-- only a nudge to ask the provider, and one that is older than the window of the signature can never
-- be replayed. The runtime role has no DELETE, so the purge is a definer function that removes only
-- the rows of the organization of the transaction that are older than the cutoff it is given, and
-- never anything younger than seven days. The reconcile of the organization calls it with 30 days.
CREATE INDEX "subscription_event_received_idx" ON "subscription_event" USING btree ("tenant_id","received_at");
--> statement-breakpoint
CREATE FUNCTION app.subscription_event_purge(p_older_than timestamp with time zone) RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    WITH removed AS (
      DELETE FROM public.subscription_event
       WHERE tenant_id = current_setting('app.tenant_id')::uuid
         AND received_at < LEAST(p_older_than, now() - interval '7 days')
      RETURNING 1
    )
    SELECT count(*)::integer FROM removed
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.subscription_event_purge(timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.subscription_event_purge(timestamp with time zone) TO app_rw;
