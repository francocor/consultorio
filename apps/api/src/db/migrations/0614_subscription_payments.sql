CREATE TABLE "subscription_attempt" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"payer_email" text,
	"previous_amount_cents" bigint,
	"statement_id" uuid,
	"payment_id" text,
	"refund_ids_before" jsonb,
	"state" text DEFAULT 'marked' NOT NULL,
	"resource_id" text,
	"resource_url" text,
	"outcome_unknown" boolean DEFAULT false NOT NULL,
	"message" text,
	"marked_at" timestamp with time zone NOT NULL,
	"settle_until" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "subscription_attempt_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_attempt_kind_check" CHECK ("subscription_attempt"."kind" in ('preapproval', 'amount_change', 'payment_link', 'refund', 'cancel')),
	CONSTRAINT "subscription_attempt_state_check" CHECK ("subscription_attempt"."state" in ('marked', 'confirmed', 'rejected', 'released', 'parked')),
	CONSTRAINT "subscription_attempt_amount_check" CHECK ("subscription_attempt"."amount_cents" >= 0),
	CONSTRAINT "subscription_attempt_resolved_check" CHECK (("subscription_attempt"."state" in ('marked', 'parked')) = ("subscription_attempt"."resolved_at" is null)),
	CONSTRAINT "subscription_attempt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "subscription_attempt_subscription_fkey" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscription"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "subscription_payment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"provider_payment_id" text NOT NULL,
	"purpose" text NOT NULL,
	"reference" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"period" text,
	"surplus" boolean DEFAULT false NOT NULL,
	"surplus_reviewed_at" timestamp with time zone,
	"credited" boolean DEFAULT false NOT NULL,
	"statement_id" uuid,
	"approved_at" timestamp with time zone,
	"provider_created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscription_payment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_payment_provider_key" UNIQUE("tenant_id","provider_payment_id"),
	CONSTRAINT "subscription_payment_purpose_check" CHECK ("subscription_payment"."purpose" in ('charge', 'overdue', 'statement')),
	CONSTRAINT "subscription_payment_status_check" CHECK ("subscription_payment"."status" in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'charged_back')),
	CONSTRAINT "subscription_payment_amount_check" CHECK ("subscription_payment"."amount_cents" > 0),
	CONSTRAINT "subscription_payment_refunded_check" CHECK ("subscription_payment"."refunded_cents" >= 0 and "subscription_payment"."refunded_cents" <= "subscription_payment"."amount_cents"),
	CONSTRAINT "subscription_payment_period_check" CHECK ("subscription_payment"."period" is null or "subscription_payment"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "subscription_payment_surplus_check" CHECK (not "subscription_payment"."surplus" or "subscription_payment"."credited"),
	CONSTRAINT "subscription_payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "subscription_payment_subscription_fkey" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscription"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "subscription_refund" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_refund_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source" text NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscription_refund_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_refund_provider_key" UNIQUE("tenant_id","provider_refund_id"),
	CONSTRAINT "subscription_refund_amount_check" CHECK ("subscription_refund"."amount_cents" > 0),
	CONSTRAINT "subscription_refund_source_check" CHECK ("subscription_refund"."source" in ('operator', 'provider')),
	CONSTRAINT "subscription_refund_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "authorized_amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "next_charge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "first_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "attention_reason" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "attention_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_refund" ADD CONSTRAINT "subscription_refund_payment_fkey" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."subscription_payment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_attempt_key" ON "subscription_attempt" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "subscription_attempt_reference_idx" ON "subscription_attempt" USING btree ("external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_attempt_open_key" ON "subscription_attempt" USING btree ("subscription_id","kind",coalesce("payment_id", '')) WHERE "subscription_attempt"."state" in ('marked', 'parked');--> statement-breakpoint
CREATE INDEX "subscription_payment_subscription_idx" ON "subscription_payment" USING btree ("subscription_id","provider_created_at");--> statement-breakpoint
CREATE INDEX "subscription_payment_surplus_idx" ON "subscription_payment" USING btree ("tenant_id") WHERE "subscription_payment"."surplus" and "subscription_payment"."surplus_reviewed_at" is null;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_attention_check" CHECK ("subscription"."attention_reason" is null or "subscription"."attention_reason" in ('ambiguous_preapproval', 'identity_mismatch', 'unexpected_state', 'reauthorization_needed'));--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_attention_at_check" CHECK (("subscription"."attention_reason" is null) = ("subscription"."attention_at" is null));
--> statement-breakpoint
ALTER TABLE "subscription_attempt" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_attempt" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_attempt" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "subscription_payment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_payment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_payment" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "subscription_refund" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_refund" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_refund" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The write-ahead log, the payments and the refunds are the record of what the platform asked the
-- provider and what the provider confirmed: the application never deletes them.
REVOKE DELETE, TRUNCATE ON "subscription_attempt", "subscription_payment", "subscription_refund" FROM app_rw;
--> statement-breakpoint
-- A write to the provider (the write-ahead log). What identifies the attempt never changes: the
-- reference, the key, what was asked and when it was sent. It is resolved once: an attempt that left
-- `marked` or `parked` stays as it ended. A parked one is the only one a person may release or
-- confirm afterwards.
-- Error codes: 23000 the rule "this never changes".
CREATE FUNCTION app.subscription_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.payer_email IS DISTINCT FROM OLD.payer_email
       OR NEW.previous_amount_cents IS DISTINCT FROM OLD.previous_amount_cents
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.refund_ids_before IS DISTINCT FROM OLD.refund_ids_before
       OR NEW.statement_id IS DISTINCT FROM OLD.statement_id
       OR NEW.marked_at IS DISTINCT FROM OLD.marked_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'what was asked of the provider never changes' USING ERRCODE = '23000';
    END IF;
    IF OLD.state IN ('confirmed', 'rejected', 'released') AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'a resolved write to the provider does not change state' USING ERRCODE = '23000';
    END IF;
    IF OLD.state IN ('confirmed', 'rejected', 'released')
       AND (NEW.resource_id IS DISTINCT FROM OLD.resource_id
            OR NEW.resource_url IS DISTINCT FROM OLD.resource_url
            OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
      RAISE EXCEPTION 'a resolved write to the provider does not change' USING ERRCODE = '23000';
    END IF;
    -- The pin only grows: nothing shortens the time a request that was given up on may still land.
    IF NEW.settle_until < OLD.settle_until THEN
      RAISE EXCEPTION 'the settle time of a write to the provider never shortens' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_attempt_guard BEFORE UPDATE ON "subscription_attempt"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_attempt_guard();
--> statement-breakpoint
-- A payment of the provider. Its identity never changes, a status only moves forward (an old
-- "pending" read after an "approved" is refused here too), and the amount refunded only grows. What
-- the provider confirmed is never un-credited by an update.
CREATE FUNCTION app.subscription_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    old_rank integer;
    new_rank integer;
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'the identity of a payment never changes' USING ERRCODE = '23000';
    END IF;
    old_rank := CASE OLD.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 1
      WHEN 'cancelled' THEN 1 WHEN 'partially_refunded' THEN 2 ELSE 3 END;
    new_rank := CASE NEW.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 1
      WHEN 'cancelled' THEN 1 WHEN 'partially_refunded' THEN 2 ELSE 3 END;
    IF new_rank < old_rank OR (new_rank = old_rank AND NEW.status IS DISTINCT FROM OLD.status
                               AND old_rank <> 0) THEN
      RAISE EXCEPTION 'a payment never goes back to an earlier status' USING ERRCODE = '23514';
    END IF;
    IF NEW.refunded_cents < OLD.refunded_cents THEN
      RAISE EXCEPTION 'the amount refunded never shrinks' USING ERRCODE = '23514';
    END IF;
    IF OLD.credited AND (NEW.credited IS DISTINCT FROM OLD.credited
                         OR NEW.period IS DISTINCT FROM OLD.period
                         OR NEW.surplus IS DISTINCT FROM OLD.surplus) THEN
      RAISE EXCEPTION 'what a payment credited never changes' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_payment_guard BEFORE UPDATE ON "subscription_payment"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_payment_guard();
--> statement-breakpoint
-- A refund is an entry of its own and never changes.
CREATE FUNCTION app.subscription_refund_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    RAISE EXCEPTION 'a refund is never changed' USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_refund_immutable BEFORE UPDATE ON "subscription_refund"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_refund_immutable();
--> statement-breakpoint
-- A notice of the payments provider carries a resource and no organization. This finds the
-- organization and the subscription a resource, a payment or a reference belongs to, from the
-- records the platform keeps of what it asked and what the provider confirmed, and returns ids and
-- nothing else: no state, no amount, no payer. Owned by the role that owns the tables; the owner
-- policies below let it see across organizations, and the runtime role has no policy beyond its own.
CREATE POLICY "subscription_owner_lookup" ON "subscription" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE POLICY "subscription_attempt_owner_lookup" ON "subscription_attempt" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE POLICY "subscription_payment_owner_lookup" ON "subscription_payment" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE FUNCTION app.subscription_for_notice(p_preapproval_id text, p_payment_id text, p_reference text)
RETURNS TABLE (tenant_id uuid, subscription_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT s.tenant_id, s.id
    FROM public.subscription s
   WHERE (p_preapproval_id IS NOT NULL AND s.provider_preapproval_id = p_preapproval_id)
      OR (p_reference IS NOT NULL AND s.external_reference = p_reference)
      OR (p_payment_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.subscription_payment p
             WHERE p.tenant_id = s.tenant_id AND p.subscription_id = s.id
               AND p.provider_payment_id = p_payment_id))
      OR (p_reference IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.subscription_attempt a
             WHERE a.tenant_id = s.tenant_id AND a.subscription_id = s.id
               AND a.external_reference = p_reference))
   ORDER BY s.tenant_id, s.id
   LIMIT 5
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.subscription_for_notice(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.subscription_for_notice(text, text, text) TO app_rw;
--> statement-breakpoint
-- What the platform operator sees of the payments of an organization: the flags of a surplus and the
-- amounts, never a payer or a method. The directory policy lets the console count them across
-- organizations.
GRANT SELECT ("id", "tenant_id", "subscription_id", "purpose", "amount_cents", "status", "refunded_cents",
              "period", "surplus", "surplus_reviewed_at", "created_at")
  ON "subscription_payment" TO app_operator;
--> statement-breakpoint
CREATE POLICY "operator_directory" ON "subscription_payment" FOR SELECT TO app_operator USING (true);
--> statement-breakpoint
-- The operator sees the cause a subscription was parked for (it is the item the operator works).
GRANT SELECT ("attention_reason", "attention_at") ON "subscription" TO app_operator;
