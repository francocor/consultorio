CREATE TABLE "local_mp_control" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'ok' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_mp_control_single_row_check" CHECK ("local_mp_control"."id" = 1),
	CONSTRAINT "local_mp_control_mode_check" CHECK ("mode" in ('ok', 'down', 'refuse_amount_change', 'duplicate_events', 'out_of_order', 'lose_answer', 'reauthorize'))
);
--> statement-breakpoint
CREATE TABLE "local_mp_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"link_id" text NOT NULL,
	"external_reference" text NOT NULL,
	"payer_email" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'ARS' NOT NULL,
	"title" text NOT NULL,
	"back_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_mp_link_amount_check" CHECK ("local_mp_link"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "local_mp_payment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"payment_id" text NOT NULL,
	"external_reference" text NOT NULL,
	"preapproval_id" text,
	"link_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'ARS' NOT NULL,
	"status" text NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"refunds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_mp_payment_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'charged_back')),
	CONSTRAINT "local_mp_payment_amount_check" CHECK ("local_mp_payment"."amount_cents" > 0),
	CONSTRAINT "local_mp_payment_refunded_check" CHECK ("local_mp_payment"."refunded_cents" >= 0 and "local_mp_payment"."refunded_cents" <= "local_mp_payment"."amount_cents"),
	CONSTRAINT "local_mp_payment_origin_check" CHECK (("local_mp_payment"."preapproval_id" is null) <> ("local_mp_payment"."link_id" is null))
);
--> statement-breakpoint
CREATE TABLE "local_mp_preapproval" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"preapproval_id" text NOT NULL,
	"external_reference" text NOT NULL,
	"payer_email" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"pending_amount_cents" bigint,
	"currency" text DEFAULT 'ARS' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_method_label" text,
	"next_charge_at" timestamp with time zone,
	"back_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_mp_preapproval_status_check" CHECK ("status" in ('pending', 'authorized', 'paused', 'cancelled')),
	CONSTRAINT "local_mp_preapproval_amount_check" CHECK ("local_mp_preapproval"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "local_mp_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_mp_link_id_key" ON "local_mp_link" USING btree ("epoch","link_id");--> statement-breakpoint
CREATE INDEX "local_mp_link_reference_idx" ON "local_mp_link" USING btree ("epoch","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "local_mp_payment_id_key" ON "local_mp_payment" USING btree ("epoch","payment_id");--> statement-breakpoint
CREATE INDEX "local_mp_payment_preapproval_idx" ON "local_mp_payment" USING btree ("epoch","preapproval_id");--> statement-breakpoint
CREATE INDEX "local_mp_payment_reference_idx" ON "local_mp_payment" USING btree ("epoch","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "local_mp_preapproval_id_key" ON "local_mp_preapproval" USING btree ("epoch","preapproval_id");--> statement-breakpoint
CREATE INDEX "local_mp_preapproval_reference_idx" ON "local_mp_preapproval" USING btree ("epoch","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "local_mp_request_key" ON "local_mp_request" USING btree ("epoch","idempotency_key");--> statement-breakpoint
-- The simulator stands in for Mercado Pago: what it answered is never removed (a reset moves
-- local_mp_control.epoch forward instead), and the control row is never deleted. Preapprovals,
-- payments and refunds change state, so they keep UPDATE; the record of the answers to a key is
-- append only. These tables are platform data, read and written by the application role in the
-- development and demonstration environments, never in production (the guard of the configuration
-- refuses the simulator there).
REVOKE DELETE, TRUNCATE ON "local_mp_control", "local_mp_preapproval", "local_mp_link", "local_mp_payment" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "local_mp_request" FROM app_rw;
