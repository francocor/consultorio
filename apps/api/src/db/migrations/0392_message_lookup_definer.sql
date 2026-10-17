-- Stage 3, E integration: message_lookup_definer (judgment day finding C10).
--
-- Migration 0322 let any role that sets a transaction-local setting read WHOLE rows of "message",
-- across organizations (two permissive SELECT policies). Only the tenant ids were ever needed. They
-- are replaced by two functions that return nothing else, owned by the role that owns the tables.
-- Row level security is FORCEd, so the owner is given a read-only policy of its own: it is what lets
-- these functions see across organizations; the runtime role gets no policy beyond its tenant one.
DROP POLICY "message_provider_lookup" ON "message";
--> statement-breakpoint
DROP POLICY "message_recipient_lookup" ON "message";
--> statement-breakpoint
CREATE POLICY "message_owner_lookup" ON "message" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
-- The organization that sent the message the provider calls this (at most one, in practice).
CREATE FUNCTION app.message_tenants_by_provider_id(p_provider_message_id text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT m.tenant_id
    FROM public.message m
   WHERE m.provider_message_id = p_provider_message_id
   ORDER BY m.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.message_tenants_by_provider_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.message_tenants_by_provider_id(text) TO app_rw;
--> statement-breakpoint
-- The organizations that wrote to a number (by its hash) over WhatsApp since a moment, the one that
-- wrote last first, at most p_limit of them (never more than 20). A reply carries no organization:
-- this is how it is attributed.
CREATE FUNCTION app.whatsapp_reply_tenants(p_address_hash text, p_since timestamp with time zone, p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.tenant_id
    FROM public.message m
   WHERE m.channel = 'whatsapp'
     AND m.address_hash = p_address_hash
     AND coalesce(m.sent_at, m.created_at) >= p_since
   GROUP BY m.tenant_id
   ORDER BY max(coalesce(m.sent_at, m.created_at)) DESC, m.tenant_id
   LIMIT greatest(least(p_limit, 20), 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.whatsapp_reply_tenants(text, timestamp with time zone, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.whatsapp_reply_tenants(text, timestamp with time zone, integer) TO app_rw;
--> statement-breakpoint
-- The organization of the message a reply quotes, but only when that message went to the number the
-- reply came from: a reply cannot be pointed at an organization by quoting a message of someone else.
CREATE FUNCTION app.whatsapp_reply_context_tenants(p_provider_message_id text, p_address_hash text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT m.tenant_id
    FROM public.message m
   WHERE m.provider_message_id = p_provider_message_id
     AND m.channel = 'whatsapp'
     AND m.address_hash = p_address_hash
   ORDER BY m.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.whatsapp_reply_context_tenants(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.whatsapp_reply_context_tenants(text, text) TO app_rw;
