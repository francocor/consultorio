CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'ARS' NOT NULL,
	"price_per_professional_cents" bigint NOT NULL,
	"max_active_professionals" integer NOT NULL,
	"whatsapp_quota_per_professional" integer DEFAULT 200 NOT NULL,
	"overage_unit_price_cents" integer NOT NULL,
	"overage_cap_default" integer NOT NULL,
	"overage_cap_max" integer NOT NULL,
	"trial_days" integer DEFAULT 14 NOT NULL,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_key_key" UNIQUE("key"),
	CONSTRAINT "plan_key_check" CHECK ("plan"."key" ~ '^[a-z][a-z0-9-]{0,39}$'),
	CONSTRAINT "plan_currency_check" CHECK ("plan"."currency" = 'ARS'),
	CONSTRAINT "plan_price_check" CHECK ("plan"."price_per_professional_cents" >= 0),
	CONSTRAINT "plan_max_professionals_check" CHECK ("plan"."max_active_professionals" >= 1),
	CONSTRAINT "plan_quota_check" CHECK ("plan"."whatsapp_quota_per_professional" >= 0),
	CONSTRAINT "plan_overage_price_check" CHECK ("plan"."overage_unit_price_cents" >= 0),
	CONSTRAINT "plan_overage_cap_check" CHECK ("plan"."overage_cap_default" >= 0 and "plan"."overage_cap_default" <= "plan"."overage_cap_max"),
	CONSTRAINT "plan_trial_days_check" CHECK ("plan"."trial_days" >= 0),
	CONSTRAINT "plan_grace_days_check" CHECK ("plan"."grace_days" >= 1)
);
--> statement-breakpoint
CREATE TABLE "plan_entitlement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"plan_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"limit_value" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_entitlement_plan_feature_key" UNIQUE("plan_id","feature"),
	CONSTRAINT "plan_entitlement_feature_check" CHECK ("plan_entitlement"."feature" ~ '^[a-z][a-z0-9_]{0,59}$'),
	CONSTRAINT "plan_entitlement_limit_check" CHECK ("plan_entitlement"."limit_value" is null or "plan_entitlement"."limit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"grace_ends_at" timestamp with time zone,
	"paid_through" timestamp with time zone,
	"dunning_step" smallint DEFAULT 0 NOT NULL,
	"overage_cap_messages" integer NOT NULL,
	"authorization_state" text DEFAULT 'none' NOT NULL,
	"provider_preapproval_id" text,
	"external_reference" text,
	"payment_method_label" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "subscription_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "subscription_status_check" CHECK ("subscription"."status" in ('trial', 'active', 'past_due', 'read_only', 'cancelling', 'cancelled')),
	CONSTRAINT "subscription_authorization_check" CHECK ("subscription"."authorization_state" in ('none', 'pending', 'authorized', 'lost')),
	CONSTRAINT "subscription_dunning_step_check" CHECK ("subscription"."dunning_step" between 0 and 3),
	CONSTRAINT "subscription_overage_cap_check" CHECK ("subscription"."overage_cap_messages" >= 0),
	CONSTRAINT "subscription_version_check" CHECK ("subscription"."version" >= 1),
	CONSTRAINT "subscription_grace_check" CHECK ("subscription"."status" not in ('past_due', 'read_only') or "subscription"."grace_ends_at" is not null),
	CONSTRAINT "subscription_preapproval_check" CHECK ("subscription"."provider_preapproval_id" is null or "subscription"."external_reference" is not null),
	CONSTRAINT "subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "subscription_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id")
);
--> statement-breakpoint
CREATE TABLE "subscription_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"resource_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_event_event_id_key" UNIQUE("event_id"),
	CONSTRAINT "subscription_event_topic_check" CHECK ("subscription_event"."topic" in ('preapproval', 'payment', 'authorized_payment')),
	CONSTRAINT "subscription_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_preapproval_key" ON "subscription" USING btree ("provider_preapproval_id") WHERE "subscription"."provider_preapproval_id" is not null;--> statement-breakpoint
CREATE INDEX "subscription_status_idx" ON "subscription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscription_event_resource_idx" ON "subscription_event" USING btree ("tenant_id","resource_id");
--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "subscription_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_event" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Who may read and write each table of this migration.
--
-- `plan` and `plan_entitlement` are platform catalogs (no tenant_id): every organization reads them
-- and the runtime role cannot change them, so a tenant can never edit the price or the limits it is
-- held to. The platform operator maintains them as data, with no release (it may add a plan and
-- change one; a plan is retired with `active = false`, never deleted, because subscriptions point
-- at it).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "plan", "plan_entitlement" FROM app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON "plan", "plan_entitlement" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("name", "price_per_professional_cents", "max_active_professionals", "whatsapp_quota_per_professional",
              "overage_unit_price_cents", "overage_cap_default", "overage_cap_max", "trial_days", "grace_days",
              "active", "updated_at") ON "plan" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("limit_value") ON "plan_entitlement" TO app_operator;
--> statement-breakpoint
-- The subscription and its notices are never deleted by the application: an organization that
-- ends is `cancelled`, and its rows stay as the record of what it was charged.
REVOKE DELETE, TRUNCATE ON "subscription", "subscription_event" FROM app_rw;
--> statement-breakpoint
-- An exempt organization has NO subscription: a demo (never charged, never limited) and one a
-- deployment without billing marked `billing_exempt`. The trigger is the backstop of the rule that
-- the application also keeps (`startTrial` answers `exempt` and writes nothing).
CREATE FUNCTION app.subscription_exempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM public.tenant t
       WHERE t.id = NEW.tenant_id AND (t.billing_exempt OR t.is_demo)
    ) THEN
      RAISE EXCEPTION 'an exempt organization has no subscription' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_exempt_guard BEFORE INSERT ON "subscription"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_exempt_guard();
--> statement-breakpoint
-- The transition table of the subscription, repeated in the database as a backstop of
-- `domain/subscription-state.ts` (the application decides; this refuses what no path may do):
--   trial      -> active, past_due, cancelling
--   active     -> past_due, cancelling
--   past_due   -> active, read_only, cancelling
--   read_only  -> active, cancelling
--   cancelling -> active, trial, cancelled
--   cancelled  -> nothing
-- The identity of a subscription never changes, and neither does the end of its trial.
-- Error codes: 23000 the rule "this never changes"; 23514 a transition that no path may make.
CREATE FUNCTION app.subscription_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at THEN
      RAISE EXCEPTION 'the identity of a subscription never changes' USING ERRCODE = '23000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'trial' AND NEW.status IN ('active', 'past_due', 'cancelling'))
      OR (OLD.status = 'active' AND NEW.status IN ('past_due', 'cancelling'))
      OR (OLD.status = 'past_due' AND NEW.status IN ('active', 'read_only', 'cancelling'))
      OR (OLD.status = 'read_only' AND NEW.status IN ('active', 'cancelling'))
      OR (OLD.status = 'cancelling' AND NEW.status IN ('active', 'trial', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'this change of subscription status is not allowed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_guard BEFORE UPDATE ON "subscription"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_guard();
--> statement-breakpoint
-- A notice of the provider is a record of what was asked about: once written it never changes.
CREATE FUNCTION app.subscription_event_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    RAISE EXCEPTION 'a notice of the payments provider is never changed' USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_event_immutable BEFORE UPDATE ON "subscription_event"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_event_immutable();
--> statement-breakpoint
-- The starting plan. Without a plan no organization can begin a trial, so it is part of the schema
-- (the same row `db/seed/plans.ts` re-asserts); prices and limits are data the operator changes, and
-- a migration that runs again never overwrites them.
INSERT INTO "plan" ("key", "name", "currency", "price_per_professional_cents", "max_active_professionals",
                    "whatsapp_quota_per_professional", "overage_unit_price_cents", "overage_cap_default",
                    "overage_cap_max", "trial_days", "grace_days")
VALUES ('standard', 'Plan Profesional', 'ARS', 1800000, 20, 200, 6000, 300, 3000, 14, 7)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- What the platform operator sees of a subscription, for support and for the console's list: the
-- state, its dates and the counters, never anything about a person. The directory policy lets the
-- console list every organization; the provider ids and the payment-method label are not granted.
GRANT SELECT ("id", "tenant_id", "plan_id", "status", "trial_ends_at", "grace_ends_at", "paid_through",
              "dunning_step", "authorization_state", "overage_cap_messages", "created_at", "updated_at")
  ON "subscription" TO app_operator;
--> statement-breakpoint
CREATE POLICY "operator_directory" ON "subscription" FOR SELECT TO app_operator USING (true);
