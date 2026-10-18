CREATE TABLE "local_afip_control" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'ok' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_afip_control_single_row_check" CHECK ("local_afip_control"."id" = 1),
	CONSTRAINT "local_afip_control_mode_check" CHECK ("mode" in ('ok', 'down', 'slow', 'timeout_after_authorize', 'reject_next'))
);
--> statement-breakpoint
CREATE TABLE "local_afip_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"voucher_id" uuid,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_afip_request_outcome_check" CHECK ("local_afip_request"."outcome" in ('authorized', 'rejected')),
	CONSTRAINT "local_afip_request_shape_check" CHECK (("local_afip_request"."outcome" = 'authorized') = ("local_afip_request"."voucher_id" is not null)
          and ("local_afip_request"."outcome" = 'rejected') = ("local_afip_request"."message" is not null))
);
--> statement-breakpoint
CREATE TABLE "local_afip_voucher" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"issuer_cuit" text NOT NULL,
	"point_of_sale" integer NOT NULL,
	"type" text NOT NULL,
	"number" integer NOT NULL,
	"cae" text NOT NULL,
	"cae_expires_on" date NOT NULL,
	"issue_date" date NOT NULL,
	"total_cents" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_afip_voucher_cae_check" CHECK ("local_afip_voucher"."cae" ~ '^[1-9][0-9]{13}$'),
	CONSTRAINT "local_afip_voucher_number_check" CHECK ("local_afip_voucher"."number" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_afip_request_key" ON "local_afip_request" USING btree ("epoch","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "local_afip_voucher_number_key" ON "local_afip_voucher" USING btree ("epoch","issuer_cuit","point_of_sale","type","number");--> statement-breakpoint
CREATE INDEX "local_afip_voucher_created_idx" ON "local_afip_voucher" USING btree ("created_at");
--> statement-breakpoint
-- The simulator stands in for the tax authority: what it authorized is never changed or removed (a reset moves local_afip_control.epoch forward instead), and the control row is never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON "local_afip_voucher" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "local_afip_request" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "local_afip_control" FROM app_rw;
