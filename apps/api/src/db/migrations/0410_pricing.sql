CREATE TABLE "payer_plan_price" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_payer_id" uuid NOT NULL,
	"plan_name" text,
	"appointment_type_id" uuid NOT NULL,
	"payer_amount_cents" bigint NOT NULL,
	"copago_cents" bigint DEFAULT 0 NOT NULL,
	"plus_cents" bigint DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payer_plan_price_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payer_plan_price_amounts_check" CHECK ("payer_plan_price"."payer_amount_cents" >= 0 and "payer_plan_price"."copago_cents" >= 0 and "payer_plan_price"."plus_cents" >= 0
        and "payer_plan_price"."payer_amount_cents" + "payer_plan_price"."copago_cents" + "payer_plan_price"."plus_cents" > 0),
	CONSTRAINT "payer_plan_price_plan_check" CHECK ("payer_plan_price"."plan_name" is null or length(btrim("payer_plan_price"."plan_name")) > 0),
	CONSTRAINT "payer_plan_price_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "payer_plan_price_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "price" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"professional_id" uuid,
	"specialty" text,
	"location_id" uuid,
	"amount_cents" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "price_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_amount_check" CHECK ("price"."amount_cents" > 0),
	CONSTRAINT "price_specialty_check" CHECK ("price"."specialty" is null or length(btrim("price"."specialty")) > 0),
	CONSTRAINT "price_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "price_type_fkey" FOREIGN KEY ("tenant_id","appointment_type_id") REFERENCES "public"."appointment_type"("tenant_id","id"),
	CONSTRAINT "price_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "price_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenant_payer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payer_id" uuid,
	"custom_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "tenant_payer_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_payer_one_source_check" CHECK (("tenant_payer"."payer_id" is null) <> ("tenant_payer"."custom_name" is null)),
	CONSTRAINT "tenant_payer_active_check" CHECK ("tenant_payer"."active" = ("tenant_payer"."deactivated_at" is null)),
	CONSTRAINT "tenant_payer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "tenant_payer_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id")
);
--> statement-breakpoint
ALTER TABLE "payer_plan_price" ADD CONSTRAINT "payer_plan_price_payer_fkey" FOREIGN KEY ("tenant_id","tenant_payer_id") REFERENCES "public"."tenant_payer"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_plan_price_scope_key" ON "payer_plan_price" USING btree ("tenant_id","tenant_payer_id",coalesce(lower("plan_name"), ''),"appointment_type_id","effective_from") WHERE "payer_plan_price"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "price_scope_key" ON "price" USING btree ("tenant_id","appointment_type_id",coalesce("professional_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce(lower("specialty"), ''),coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid),"effective_from") WHERE "price"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_payer_catalog_key" ON "tenant_payer" USING btree ("tenant_id","payer_id") WHERE "tenant_payer"."payer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_payer_custom_key" ON "tenant_payer" USING btree ("tenant_id",lower("custom_name")) WHERE "tenant_payer"."custom_name" is not null;
--> statement-breakpoint
ALTER TABLE "tenant_payer" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_payer" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_payer" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "price" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "payer_plan_price" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payer_plan_price" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payer_plan_price" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Prices and payers are deactivated, never deleted: a charge keeps the figures it applied, and a payer that was deactivated still shows on the charges it was made for (billing-payments, "Deactivated payer").
REVOKE DELETE, TRUNCATE ON "tenant_payer" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "price" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "payer_plan_price" FROM app_rw;
