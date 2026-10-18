-- Stage 3, E integration: reply_tenants_any_hash (judgment day round 4, finding T1).
--
-- While the log still holds unsalted address hashes (the rehash goes a batch at a time) a number may
-- be on the books under the keyed hash in one organization and under the unsalted one in another.
-- The webhook asked app.whatsapp_reply_tenants once per hash and merged the answers, which lost the
-- order "the organization that wrote last first": whichever hash was asked first came first. This
-- function takes every hash of the number at once and orders by the latest write under any of them,
-- before the limit is applied. Like the others it returns tenant ids and nothing else.
CREATE FUNCTION app.whatsapp_reply_tenants_any(p_address_hashes text[], p_since timestamp with time zone, p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.tenant_id
    FROM public.message m
   WHERE m.channel = 'whatsapp'
     AND m.address_hash = ANY (p_address_hashes[1:4])
     AND coalesce(m.sent_at, m.created_at) >= p_since
   GROUP BY m.tenant_id
   ORDER BY max(coalesce(m.sent_at, m.created_at)) DESC, m.tenant_id
   LIMIT greatest(least(p_limit, 20), 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.whatsapp_reply_tenants_any(text[], timestamp with time zone, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.whatsapp_reply_tenants_any(text[], timestamp with time zone, integer) TO app_rw;
