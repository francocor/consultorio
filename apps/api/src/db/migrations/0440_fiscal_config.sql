CREATE TABLE "fiscal_credential" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"certificate_enc" "bytea" NOT NULL,
	"private_key_enc" "bytea" NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"subject_cuit" text NOT NULL,
	"fingerprint" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"replaced_at" timestamp with time zone,
	"expiry_warned_at" timestamp with time zone,
	"uploaded_by" uuid,
	CONSTRAINT "fiscal_credential_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fiscal_credential_cuit_check" CHECK ("fiscal_credential"."subject_cuit" ~ '^[0-9]{11}$'),
	CONSTRAINT "fiscal_credential_fingerprint_check" CHECK ("fiscal_credential"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fiscal_credential_active_check" CHECK (("fiscal_credential"."active") = ("fiscal_credential"."replaced_at" is null)),
	CONSTRAINT "fiscal_credential_window_check" CHECK ("fiscal_credential"."not_after" > "fiscal_credential"."not_before"),
	CONSTRAINT "fiscal_credential_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "fiscal_profile" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cuit" text NOT NULL,
	"tax_condition" text NOT NULL,
	"business_name" text NOT NULL,
	"address" text NOT NULL,
	"activity_started_on" date NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "fiscal_profile_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fiscal_profile_cuit_check" CHECK ("fiscal_profile"."cuit" ~ '^[0-9]{11}$'),
	CONSTRAINT "fiscal_profile_tax_condition_check" CHECK ("tax_condition" in ('monotributo', 'responsable_inscripto', 'exento')),
	CONSTRAINT "fiscal_profile_name_check" CHECK (length(btrim("fiscal_profile"."business_name")) > 0 and length(btrim("fiscal_profile"."address")) > 0),
	CONSTRAINT "fiscal_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "point_of_sale" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"environment" text DEFAULT 'homologation' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "point_of_sale_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "point_of_sale_number_check" CHECK ("point_of_sale"."number" between 1 and 99999),
	CONSTRAINT "point_of_sale_environment_check" CHECK ("environment" in ('homologation', 'production')),
	CONSTRAINT "point_of_sale_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_credential_active_key" ON "fiscal_credential" USING btree ("tenant_id") WHERE "fiscal_credential"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_profile_tenant_key" ON "fiscal_profile" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "point_of_sale_number_key" ON "point_of_sale" USING btree ("tenant_id","number");
--> statement-breakpoint
ALTER TABLE "fiscal_profile" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fiscal_profile" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fiscal_profile" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "point_of_sale" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "point_of_sale" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "point_of_sale" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "fiscal_credential" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fiscal_credential" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fiscal_credential" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- The fiscal profile, the points of sale and the credential history are deactivated or replaced, never deleted: issued invoices refer to their numbers and the history of the certificate is part of the audit trail (e-invoicing-afip, "Invoice immutability").
REVOKE DELETE, TRUNCATE ON "fiscal_profile" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "point_of_sale" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "fiscal_credential" FROM app_rw;
