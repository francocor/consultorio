CREATE TABLE "charge" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tenant_payer_id" uuid,
	"plan_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"explicit_amount" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"flagged_at" timestamp with time zone,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"captured_by" uuid NOT NULL,
	CONSTRAINT "charge_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "charge_status_check" CHECK ("status" in ('pending', 'partially_paid', 'paid', 'voided')),
	CONSTRAINT "charge_void_check" CHECK (("charge"."status" = 'voided') = ("charge"."void_reason" is not null)
        and ("charge"."status" = 'voided') = ("charge"."voided_at" is not null)),
	CONSTRAINT "charge_review_check" CHECK (("needs_review") = ("review_reason" is not null) and ("needs_review") = ("flagged_at" is not null) and ("review_reason" is null or "review_reason" in ('no_show', 'cancelled'))),
	CONSTRAINT "charge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "charge_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id"),
	CONSTRAINT "charge_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "charge_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "charge_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id"),
	CONSTRAINT "charge_payer_fkey" FOREIGN KEY ("tenant_id","tenant_payer_id") REFERENCES "public"."tenant_payer"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "charge_line" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"charge_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" text NOT NULL,
	"portion" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"invoiced_cents" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	CONSTRAINT "charge_line_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "charge_line_kind_check" CHECK ("kind" in ('service', 'payer_coverage', 'copago', 'plus', 'late_fee', 'manual')),
	CONSTRAINT "charge_line_portion_check" CHECK ("portion" in ('patient', 'payer')),
	CONSTRAINT "charge_line_description_check" CHECK (length(btrim("charge_line"."description")) between 1 and 200),
	CONSTRAINT "charge_line_amount_check" CHECK ("charge_line"."amount_cents" > 0),
	CONSTRAINT "charge_line_invoiced_check" CHECK ("charge_line"."invoiced_cents" >= 0 and "charge_line"."invoiced_cents" <= "charge_line"."amount_cents"),
	CONSTRAINT "charge_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "charge_line" ADD CONSTRAINT "charge_line_charge_fkey" FOREIGN KEY ("tenant_id","charge_id") REFERENCES "public"."charge"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charge_appointment_key" ON "charge" USING btree ("tenant_id","appointment_id") WHERE "charge"."status" <> 'voided';--> statement-breakpoint
CREATE INDEX "charge_location_idx" ON "charge" USING btree ("tenant_id","location_id","created_at");--> statement-breakpoint
CREATE INDEX "charge_patient_idx" ON "charge" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "charge_professional_idx" ON "charge" USING btree ("tenant_id","professional_id","created_at");--> statement-breakpoint
CREATE INDEX "charge_review_idx" ON "charge" USING btree ("tenant_id","flagged_at") WHERE "charge"."needs_review" and "charge"."status" <> 'voided';--> statement-breakpoint
CREATE UNIQUE INDEX "charge_line_position_key" ON "charge_line" USING btree ("tenant_id","charge_id","position");
--> statement-breakpoint
ALTER TABLE "charge" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "charge" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "charge" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "charge_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "charge_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "charge_line" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- A charge and its lines are voided or invoiced, never deleted (billing-payments, "Charge lifecycle and voiding").
REVOKE DELETE, TRUNCATE ON "charge" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "charge_line" FROM app_rw;
--> statement-breakpoint
-- A charge keeps its identity and the figures it applied, and a voided charge is final: it cannot be
-- reopened, re-reasoned or flagged again. Status, review flag and void data are the only things that move.
CREATE FUNCTION app.guard_charge() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.professional_id IS DISTINCT FROM OLD.professional_id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.tenant_payer_id IS DISTINCT FROM OLD.tenant_payer_id
       OR NEW.plan_name IS DISTINCT FROM OLD.plan_name
       OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
       OR NEW.explicit_amount IS DISTINCT FROM OLD.explicit_amount
       OR NEW.captured_by IS DISTINCT FROM OLD.captured_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a charge keeps its identity and the figures it applied' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'voided'
       AND (NEW.status IS DISTINCT FROM OLD.status
            OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
            OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
            OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
            OR NEW.needs_review IS DISTINCT FROM OLD.needs_review
            OR NEW.review_reason IS DISTINCT FROM OLD.review_reason) THEN
      RAISE EXCEPTION 'a voided charge is final' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER charge_guard
  BEFORE UPDATE ON "charge"
  FOR EACH ROW EXECUTE FUNCTION app.guard_charge();
--> statement-breakpoint
-- A charge line is written once. Only what has been invoiced of it moves afterwards (the invoices of
-- the invoicing module keep it in step, and the check keeps it within the amount of the line).
CREATE FUNCTION app.guard_charge_line() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.charge_id IS DISTINCT FROM OLD.charge_id
       OR NEW.position IS DISTINCT FROM OLD.position
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.portion IS DISTINCT FROM OLD.portion
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a charge line is written once; only what was invoiced of it changes'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER charge_line_guard
  BEFORE UPDATE ON "charge_line"
  FOR EACH ROW EXECUTE FUNCTION app.guard_charge_line();
--> statement-breakpoint
-- A voided charge takes no new line. A charge the caller cannot see is left to the foreign key.
CREATE FUNCTION app.guard_charge_line_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    state text;
  BEGIN
    SELECT c.status INTO state FROM charge c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.charge_id;
    IF state = 'voided' THEN
      RAISE EXCEPTION 'a voided charge takes no new line' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER charge_line_insert_guard
  BEFORE INSERT ON "charge_line"
  FOR EACH ROW EXECUTE FUNCTION app.guard_charge_line_insert();
