DROP INDEX "message_offer_url_idx";--> statement-breakpoint
ALTER TABLE "message_offer" ADD COLUMN "url_enc" "bytea";--> statement-breakpoint
CREATE INDEX "message_offer_url_idx" ON "message_offer" USING btree ("tenant_id","expires_at") WHERE "message_offer"."url_enc" is not null or "message_offer"."url" is not null;