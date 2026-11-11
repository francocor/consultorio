-- Judgment Day, Stage 3, round 2, findings A12 and R2-C2: the places of the WhatsApp quota written
-- before migration 0396 and the ones that leaked.
--
-- Before 0396 a usage row was written when the provider ACCEPTED a message, so every such row is a
-- confirmed place; 0396 added "confirmed_at" and left it empty on them. The count now takes a
-- place that is confirmed, or reserved for a message that is still queued, so those rows would have
-- stopped counting. Here a row of a message the provider took (sent, delivered, read) is confirmed
-- at the time it was counted. A row that is neither confirmed nor released and whose message ended
-- without going (cancelled, failed) is a reservation that leaked before the release was made in every
-- path; it is released. Rows of messages that are still queued are live reservations and are left as
-- they are.
--
-- A migration has no tenant context, so row level security is lifted on the two tables for the
-- length of this transaction (see migrations 0030 and 0039).
ALTER TABLE "whatsapp_usage_event" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "whatsapp_usage_event" e
   SET "confirmed_at" = e."counted_at"
  FROM "message" m
 WHERE m."tenant_id" = e."tenant_id" AND m."id" = e."message_id"
   AND e."confirmed_at" IS NULL AND e."released_at" IS NULL
   AND m."status" IN ('sent', 'delivered', 'read');
--> statement-breakpoint
UPDATE "whatsapp_usage_event" e
   SET "released_at" = now()
  FROM "message" m
 WHERE m."tenant_id" = e."tenant_id" AND m."id" = e."message_id"
   AND e."confirmed_at" IS NULL AND e."released_at" IS NULL
   AND m."status" IN ('cancelled', 'failed');
--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "whatsapp_usage_event" FORCE ROW LEVEL SECURITY;
