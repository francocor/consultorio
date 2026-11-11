-- Stage 4, D integration: whatsapp_usage_unsettled_idx (JD-S3 follow-up).
--
-- The usage backfill of the migration runner (backfillUsageConfirmation) looks, on every boot, for the
-- rows that are neither confirmed nor released. Without this index it read the whole table each time;
-- with it, only the rows still unsettled (the live reservations of queued messages among them).
-- Plain CREATE INDEX: the migrator runs in a transaction, where CONCURRENTLY is not allowed, and the
-- table only holds one small row per WhatsApp message.
CREATE INDEX "whatsapp_usage_event_unsettled_idx" ON "whatsapp_usage_event" USING btree ("tenant_id","id") WHERE "whatsapp_usage_event"."confirmed_at" is null and "whatsapp_usage_event"."released_at" is null;
