-- Judgment day, Stage 4, round 3 (finding R3-3). A number of a series that the authority may hold a
-- voucher under and that no invoice records: the number an invoice expected when it was replaced by a
-- manual voucher without knowing whether it had been issued, and the number of a voucher that arrived
-- for an invoice somebody had already closed. A closed invoice is closed to any write (`guard_invoice`),
-- so it cannot carry the number itself. A lookup never adopts a number found here, and the number
-- expected next is counted after the highest of these. A row is written once and never changed or
-- removed (the grants below). Numbered in the reserved gap 0480 - 0489 (track `4jd`): the range of
-- `4d` is full.
CREATE TABLE "invoice_stray_voucher" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"point_of_sale" integer NOT NULL,
	"type" text NOT NULL,
	"number" bigint NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "invoice_stray_voucher_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_stray_voucher_number_check" CHECK ("invoice_stray_voucher"."number" > 0),
	CONSTRAINT "invoice_stray_voucher_reason_check" CHECK ("invoice_stray_voucher"."reason" in ('replaced_unresolved', 'orphaned')),
	CONSTRAINT "invoice_stray_voucher_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "invoice_stray_voucher_invoice_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoice"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_stray_voucher_number_key" ON "invoice_stray_voucher" USING btree ("tenant_id","point_of_sale","type","number");--> statement-breakpoint
CREATE INDEX "invoice_stray_voucher_invoice_idx" ON "invoice_stray_voucher" USING btree ("tenant_id","invoice_id");
--> statement-breakpoint
ALTER TABLE "invoice_stray_voucher" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_stray_voucher" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_stray_voucher" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "invoice_stray_voucher" FROM app_rw;
