CREATE TABLE "statement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"professionals_counted" integer NOT NULL,
	"base_cents" bigint NOT NULL,
	"overage_units" integer DEFAULT 0 NOT NULL,
	"overage_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"overage_cap_messages" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"collect_after" timestamp with time zone NOT NULL,
	"collected_cents" bigint DEFAULT 0 NOT NULL,
	"collected_at" timestamp with time zone,
	CONSTRAINT "statement_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "statement_period_key" UNIQUE("subscription_id","period"),
	CONSTRAINT "statement_period_check" CHECK ("statement"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "statement_amounts_check" CHECK ("statement"."base_cents" >= 0 and "statement"."overage_cents" >= 0 and "statement"."overage_units" >= 0 and "statement"."professionals_counted" >= 1 and "statement"."total_cents" = "statement"."base_cents" + "statement"."overage_cents"),
	CONSTRAINT "statement_collected_check" CHECK ("statement"."collected_cents" >= 0 and "statement"."collected_cents" <= "statement"."total_cents"),
	CONSTRAINT "statement_window_check" CHECK ("statement"."collect_after" >= "statement"."published_at" + interval '3 days'),
	CONSTRAINT "statement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "statement_subscription_fkey" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscription"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "usage_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"professional_id" uuid NOT NULL,
	"period" text NOT NULL,
	"day" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "usage_record_kind_check" CHECK ("usage_record"."kind" in ('active_professional_day', 'whatsapp_messages')),
	CONSTRAINT "usage_record_period_check" CHECK ("usage_record"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "usage_record_quantity_check" CHECK ("usage_record"."quantity" >= 0),
	CONSTRAINT "usage_record_day_check" CHECK (("usage_record"."kind" = 'active_professional_day') = ("usage_record"."day" is not null) and ("usage_record"."day" is null or left("usage_record"."day", 7) = "usage_record"."period")),
	CONSTRAINT "usage_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "usage_record_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "subscription_notice" DROP CONSTRAINT "subscription_notice_kind_check";--> statement-breakpoint
CREATE INDEX "statement_open_idx" ON "statement" USING btree ("subscription_id","period") WHERE "statement"."collected_cents" < "statement"."total_cents";--> statement-breakpoint
CREATE UNIQUE INDEX "usage_record_day_key" ON "usage_record" USING btree ("tenant_id","professional_id","day") WHERE "usage_record"."kind" = 'active_professional_day';--> statement-breakpoint
CREATE UNIQUE INDEX "usage_record_month_key" ON "usage_record" USING btree ("tenant_id","professional_id","period") WHERE "usage_record"."kind" = 'whatsapp_messages';--> statement-breakpoint
CREATE INDEX "usage_record_period_idx" ON "usage_record" USING btree ("tenant_id","period","kind");--> statement-breakpoint
-- The two foreign keys to the statement, on tables that already exist. Both tables have FORCE row
-- level security and a migration has no tenant context, so the check that validates the constraint
-- cannot read them as the owner unless FORCE is lifted for the length of the statement (migrations
-- 0030, 0444 and 0590 do the same); they are Stage 6 tables and hold no statement reference yet.
ALTER TABLE "subscription_attempt" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_payment" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_attempt" ADD CONSTRAINT "subscription_attempt_statement_fkey" FOREIGN KEY ("tenant_id","statement_id") REFERENCES "public"."statement"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_statement_fkey" FOREIGN KEY ("tenant_id","statement_id") REFERENCES "public"."statement"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_notice" ADD CONSTRAINT "subscription_notice_kind_check" CHECK ("subscription_notice"."kind" in ('past_due_started', 'dunning_1', 'dunning_3', 'dunning_5', 'read_only_started', 'recovered', 'statement_published', 'amount_change_refused', 'reauthorization_needed', 'overage_cap_reached')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "usage_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_record" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "statement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "statement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "statement" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Statements and usage records are the record of what was billed and metered: the application never
-- deletes them.
REVOKE DELETE, TRUNCATE ON "statement" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "usage_record" FROM app_rw;
--> statement-breakpoint
-- What a statement says never changes once it is published. Only what was collected moves, up to
-- the total and never down (the table's own check holds the upper bound), and the day it was
-- completed is written once.
CREATE FUNCTION app.statement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.period IS DISTINCT FROM OLD.period
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.professionals_counted IS DISTINCT FROM OLD.professionals_counted
       OR NEW.base_cents IS DISTINCT FROM OLD.base_cents
       OR NEW.overage_units IS DISTINCT FROM OLD.overage_units
       OR NEW.overage_cents IS DISTINCT FROM OLD.overage_cents
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.overage_cap_messages IS DISTINCT FROM OLD.overage_cap_messages
       OR NEW.lines IS DISTINCT FROM OLD.lines
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.collect_after IS DISTINCT FROM OLD.collect_after
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a published statement never changes' USING ERRCODE = '23000';
    END IF;
    IF NEW.collected_cents < OLD.collected_cents THEN
      RAISE EXCEPTION 'what was collected for a statement never goes down' USING ERRCODE = '23000';
    END IF;
    IF OLD.collected_at IS NOT NULL AND NEW.collected_at IS DISTINCT FROM OLD.collected_at THEN
      RAISE EXCEPTION 'a statement that was collected stays collected' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER statement_guard BEFORE UPDATE ON "statement"
  FOR EACH ROW EXECUTE FUNCTION app.statement_guard();
--> statement-breakpoint
-- A write to the provider for a statement (a change of the recurring amount, a payment link for the
-- difference) is marked only when the owner's window has passed, and never for more than is left to
-- collect. `marked_at` is the instant the application sends the request, so the rule holds on any
-- clock the application runs on, and holds whatever the code that marks it does.
CREATE FUNCTION app.subscription_attempt_statement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    stmt record;
  BEGIN
    IF NEW.statement_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT total_cents, collected_cents, collect_after INTO stmt
      FROM statement WHERE tenant_id = NEW.tenant_id AND id = NEW.statement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nothing is collected for a statement that does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.marked_at < stmt.collect_after THEN
      RAISE EXCEPTION 'nothing is collected before the owner had time to see the statement' USING ERRCODE = '23000';
    END IF;
    IF NEW.amount_cents > stmt.total_cents - stmt.collected_cents THEN
      RAISE EXCEPTION 'nothing is collected beyond the total of the statement' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_attempt_statement_guard BEFORE INSERT ON "subscription_attempt"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_attempt_statement_guard();
--> statement-breakpoint
-- What identifies a usage record never changes; a day on which a professional was active stays as it
-- was recorded, and only the monthly count of messages is rewritten.
CREATE FUNCTION app.usage_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.professional_id IS DISTINCT FROM OLD.professional_id
       OR NEW.period IS DISTINCT FROM OLD.period
       OR NEW.day IS DISTINCT FROM OLD.day THEN
      RAISE EXCEPTION 'what a usage record is about never changes' USING ERRCODE = '23000';
    END IF;
    IF OLD.kind = 'active_professional_day' AND NEW.quantity IS DISTINCT FROM OLD.quantity THEN
      RAISE EXCEPTION 'a day of activity stays as it was recorded' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER usage_record_guard BEFORE UPDATE ON "usage_record"
  FOR EACH ROW EXECUTE FUNCTION app.usage_record_guard();
--> statement-breakpoint
-- What the platform operator sees of the usage of an organization (SUB-17, SUB-18): the days each
-- professional was active and the count of accepted messages, for the contract invoicing of a
-- single-tenant deployment and for support. The operator reads one organization at a time, through the
-- tenant context of its transaction; no message, no patient and no name is granted.
GRANT SELECT ("id", "tenant_id", "kind", "professional_id", "period", "day", "quantity", "recorded_at")
  ON "usage_record" TO app_operator;
