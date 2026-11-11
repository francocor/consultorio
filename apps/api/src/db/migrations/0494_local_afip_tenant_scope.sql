-- Judgment day, Stage 4, round 1 (finding C12): the local AFIP simulator scopes its series and its
-- answers by organization. Until now a voucher was found by the CUIT string alone and an idempotency
-- key was the same key for every organization, so two organizations with the same CUIT shared a
-- numbering series and `findIssued` read across them. The rows that exist keep the empty reference.
-- The simulator tables hold test vouchers only (they are never read in production).
DROP INDEX "local_afip_request_key";--> statement-breakpoint
DROP INDEX "local_afip_voucher_number_key";--> statement-breakpoint
ALTER TABLE "local_afip_request" ADD COLUMN "tenant_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_afip_voucher" ADD COLUMN "tenant_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "local_afip_request_key" ON "local_afip_request" USING btree ("epoch","tenant_ref","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "local_afip_voucher_number_key" ON "local_afip_voucher" USING btree ("epoch","tenant_ref","issuer_cuit","point_of_sale","type","number");