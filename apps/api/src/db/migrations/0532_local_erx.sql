CREATE TABLE "local_erx_control" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'ok' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_erx_control_single_row_check" CHECK ("local_erx_control"."id" = 1),
	CONSTRAINT "local_erx_control_mode_check" CHECK ("mode" in ('ok', 'down', 'timeout_after_issue'))
);
--> statement-breakpoint
CREATE TABLE "local_erx_prescription" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"external_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_erx_prescription_state_check" CHECK ("state" in ('issued', 'cancelled', 'dispensed', 'expired')),
	CONSTRAINT "local_erx_prescription_cancel_check" CHECK (("local_erx_prescription"."state" = 'cancelled') = ("local_erx_prescription"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "local_erx_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"epoch" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"prescription_id" uuid,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_erx_request_kind_check" CHECK ("kind" in ('issue', 'cancel')),
	CONSTRAINT "local_erx_request_outcome_check" CHECK ("outcome" in ('issued', 'cancelled', 'rejected')),
	CONSTRAINT "local_erx_request_shape_check" CHECK (("local_erx_request"."outcome" = 'rejected') = ("local_erx_request"."message" is not null)
          and ("local_erx_request"."outcome" = 'rejected') = ("local_erx_request"."prescription_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_erx_prescription_external_key" ON "local_erx_prescription" USING btree ("epoch","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_erx_prescription_key" ON "local_erx_prescription" USING btree ("epoch","idempotency_key");--> statement-breakpoint
CREATE INDEX "local_erx_prescription_created_idx" ON "local_erx_prescription" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_erx_request_key" ON "local_erx_request" USING btree ("epoch","idempotency_key");
--> statement-breakpoint
-- The simulator stands in for the authorized platform: what it answered is never removed (a reset
-- moves local_erx_control.epoch forward instead), and the control row is never deleted. A prescription
-- changes state (cancelled, dispensed, expired), so it keeps UPDATE.
REVOKE DELETE, TRUNCATE ON "local_erx_prescription" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "local_erx_request" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "local_erx_control" FROM app_rw;
