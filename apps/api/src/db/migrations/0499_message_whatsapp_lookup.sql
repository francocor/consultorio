-- Stage 4, D integration: message_whatsapp_lookup (JD-S3 follow-up).
--
-- 1. The WhatsApp webhook finds the organization a reply is about by the hash of the number, across
--    all organizations (app.whatsapp_reply_tenants_any, and whatsapp_reply_context_tenants). The
--    existing index message_address_idx leads with tenant_id, so that lookup scanned the whole log.
--    This one is on the hash alone, for WhatsApp messages only. Plain CREATE INDEX: the migrator runs
--    in a transaction, where CONCURRENTLY is not allowed.
CREATE INDEX "message_whatsapp_address_hash_idx" ON "message" USING btree ("address_hash") WHERE "message"."channel" = 'whatsapp';
--> statement-breakpoint
-- 2. app.whatsapp_reply_tenants(text, timestamptz, integer), created by 0392, was replaced by
--    app.whatsapp_reply_tenants_any (0399) and nothing calls it any more. A SECURITY DEFINER function
--    that nobody uses is attack surface for nothing, so it is dropped.
DROP FUNCTION app.whatsapp_reply_tenants(text, timestamp with time zone, integer);
