CREATE TABLE "cash_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_cents" bigint NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"expected_cents" bigint,
	"counted_cents" bigint,
	"difference_cents" bigint,
	"difference_reason" text,
	CONSTRAINT "cash_session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_session_status_check" CHECK ("status" in ('open', 'closed')),
	CONSTRAINT "cash_session_opening_check" CHECK ("cash_session"."opening_cents" >= 0),
	CONSTRAINT "cash_session_close_check" CHECK (("cash_session"."status" = 'closed') = ("cash_session"."closed_at" is not null)
        and ("cash_session"."status" = 'closed') = ("cash_session"."closed_by" is not null)
        and ("cash_session"."status" = 'closed') = ("cash_session"."expected_cents" is not null)
        and ("cash_session"."status" = 'closed') = ("cash_session"."counted_cents" is not null)
        and ("cash_session"."status" = 'closed') = ("cash_session"."difference_cents" is not null)),
	CONSTRAINT "cash_session_difference_check" CHECK ("cash_session"."status" = 'open'
        or ("cash_session"."counted_cents" >= 0
            and "cash_session"."difference_cents" = "cash_session"."counted_cents" - "cash_session"."expected_cents"
            and ("cash_session"."difference_cents" = 0
                 or length(btrim(coalesce("cash_session"."difference_reason", ''))) >= 3))),
	CONSTRAINT "cash_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "cash_session_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "export_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid NOT NULL,
	"object_key" text,
	"file_name" text,
	"size_bytes" integer,
	"row_count" integer,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "export_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "export_request_kind_check" CHECK ("kind" in ('charges', 'payments', 'payer_settlement')),
	CONSTRAINT "export_request_format_check" CHECK ("format" in ('csv', 'xlsx', 'pdf')),
	CONSTRAINT "export_request_status_check" CHECK ("status" in ('queued', 'ready', 'empty', 'failed')),
	CONSTRAINT "export_request_file_check" CHECK (("export_request"."status" = 'ready') = ("export_request"."object_key" is not null)),
	CONSTRAINT "export_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"charge_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"cash_session_id" uuid,
	"method" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"external_ref" text,
	"override_reason" text,
	"corrects_payment_id" uuid,
	CONSTRAINT "payment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_method_check" CHECK ("method" in ('cash', 'debit', 'credit', 'transfer', 'wallet', 'payment_link')),
	CONSTRAINT "payment_amount_check" CHECK ("payment"."amount_cents" > 0),
	CONSTRAINT "payment_credit_check" CHECK ("payment"."credit_cents" >= 0 and "payment"."credit_cents" <= "payment"."amount_cents"),
	CONSTRAINT "payment_cash_register_check" CHECK ("payment"."method" <> 'cash' or "payment"."cash_session_id" is not null),
	CONSTRAINT "payment_idempotency_check" CHECK (length("payment"."idempotency_key") between 8 and 128),
	CONSTRAINT "payment_reference_check" CHECK ("external_ref" is null or "external_ref" !~ '^(\d[ -]?){12,18}\d$'),
	CONSTRAINT "payment_reference_length_check" CHECK ("payment"."external_ref" is null or length(btrim("payment"."external_ref")) between 1 and 64),
	CONSTRAINT "payment_override_check" CHECK ("payment"."override_reason" is null or length(btrim("payment"."override_reason")) >= 3),
	CONSTRAINT "payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "payment_charge_fkey" FOREIGN KEY ("tenant_id","charge_id") REFERENCES "public"."charge"("tenant_id","id"),
	CONSTRAINT "payment_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "payment_reversal" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"cash_session_id" uuid,
	"amount_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"kind" text NOT NULL,
	"reversed_by" uuid NOT NULL,
	"reversed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "payment_reversal_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_reversal_amount_check" CHECK ("payment_reversal"."amount_cents" > 0),
	CONSTRAINT "payment_reversal_reason_check" CHECK (length(btrim("payment_reversal"."reason")) between 3 and 200),
	CONSTRAINT "payment_reversal_kind_check" CHECK ("kind" in ('refund', 'correction')),
	CONSTRAINT "payment_reversal_idempotency_check" CHECK (length("payment_reversal"."idempotency_key") between 8 and 128),
	CONSTRAINT "payment_reversal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "payment_reversal_charge_fkey" FOREIGN KEY ("tenant_id","charge_id") REFERENCES "public"."charge"("tenant_id","id"),
	CONSTRAINT "payment_reversal_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_cash_session_fkey" FOREIGN KEY ("tenant_id","cash_session_id") REFERENCES "public"."cash_session"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_corrects_fkey" FOREIGN KEY ("tenant_id","corrects_payment_id") REFERENCES "public"."payment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversal" ADD CONSTRAINT "payment_reversal_payment_fkey" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversal" ADD CONSTRAINT "payment_reversal_cash_session_fkey" FOREIGN KEY ("tenant_id","cash_session_id") REFERENCES "public"."cash_session"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_open_key" ON "cash_session" USING btree ("tenant_id","location_id") WHERE "cash_session"."status" = 'open';--> statement-breakpoint
CREATE INDEX "cash_session_location_idx" ON "cash_session" USING btree ("tenant_id","location_id","opened_at");--> statement-breakpoint
CREATE INDEX "export_request_requester_idx" ON "export_request" USING btree ("tenant_id","requested_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_idempotency_key" ON "payment" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reference_key" ON "payment" USING btree ("tenant_id","external_ref") WHERE "payment"."external_ref" is not null and "payment"."override_reason" is null;--> statement-breakpoint
CREATE INDEX "payment_charge_idx" ON "payment" USING btree ("tenant_id","charge_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_session_idx" ON "payment" USING btree ("tenant_id","cash_session_id") WHERE "payment"."cash_session_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_location_idx" ON "payment" USING btree ("tenant_id","location_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reversal_idempotency_key" ON "payment_reversal" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_reversal_payment_idx" ON "payment_reversal" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_reversal_charge_idx" ON "payment_reversal" USING btree ("tenant_id","charge_id");--> statement-breakpoint
CREATE INDEX "payment_reversal_session_idx" ON "payment_reversal" USING btree ("tenant_id","cash_session_id") WHERE "payment_reversal"."cash_session_id" is not null;
--> statement-breakpoint
ALTER TABLE "cash_session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cash_session" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "payment_reversal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_reversal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_reversal" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "export_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "export_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "export_request" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Money is never deleted or edited (billing-payments, "Refunds and payment reversals", "Closed register
-- immutability"): a payment and a reversal are append-only for the application role, and a register or
-- an export is never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON "payment" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_reversal" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "cash_session" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "export_request" FROM app_rw;
--> statement-breakpoint
-- A cash register that is closed does not change, and an open one keeps its place and its opening cash.
CREATE FUNCTION app.guard_cash_session() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF OLD.status = 'closed' THEN
      RAISE EXCEPTION 'a closed cash register does not change' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
       OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR NEW.opening_cents IS DISTINCT FROM OLD.opening_cents THEN
      RAISE EXCEPTION 'a cash register keeps its location and its opening' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER cash_session_guard
  BEFORE UPDATE ON "cash_session"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cash_session();
--> statement-breakpoint
-- A payment goes into an open register of its own location, and never into a voided charge. A register or
-- a charge the caller cannot see is left to the foreign key.
CREATE FUNCTION app.guard_payment() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    register record;
    state text;
  BEGIN
    IF NEW.cash_session_id IS NOT NULL THEN
      SELECT s.status, s.location_id INTO register
        FROM cash_session s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cash_session_id;
      IF FOUND THEN
        IF register.status <> 'open' THEN
          RAISE EXCEPTION 'a closed cash register takes no new entries' USING ERRCODE = '42501';
        END IF;
        IF register.location_id <> NEW.location_id THEN
          RAISE EXCEPTION 'the cash register belongs to another location' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    SELECT c.status INTO state FROM charge c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.charge_id;
    IF state = 'voided' THEN
      RAISE EXCEPTION 'a voided charge takes no payment' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER payment_guard
  BEFORE INSERT ON "payment"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment();
--> statement-breakpoint
-- The reversals of a payment never add up to more than the payment, the cash of a cash payment leaves an
-- open register of the place, and a closed register takes nothing.
CREATE FUNCTION app.guard_payment_reversal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    original record;
    register record;
    already bigint;
  BEGIN
    SELECT p.amount_cents, p.method INTO original
      FROM payment p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id;
    IF FOUND THEN
      SELECT coalesce(sum(r.amount_cents), 0) INTO already
        FROM payment_reversal r WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = NEW.payment_id;
      IF already + NEW.amount_cents > original.amount_cents THEN
        RAISE EXCEPTION 'the reversals of a payment cannot exceed the payment' USING ERRCODE = '23514';
      END IF;
      IF original.method = 'cash' AND NEW.cash_session_id IS NULL THEN
        RAISE EXCEPTION 'the cash of a refund leaves an open cash register' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.cash_session_id IS NOT NULL THEN
      SELECT s.status, s.location_id INTO register
        FROM cash_session s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cash_session_id;
      IF FOUND THEN
        IF register.status <> 'open' THEN
          RAISE EXCEPTION 'a closed cash register takes no new entries' USING ERRCODE = '42501';
        END IF;
        IF register.location_id <> NEW.location_id THEN
          RAISE EXCEPTION 'the cash register belongs to another location' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER payment_reversal_guard
  BEFORE INSERT ON "payment_reversal"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_reversal();

