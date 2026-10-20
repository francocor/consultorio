CREATE TABLE "subscription_notice" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "subscription_notice_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_notice_key" UNIQUE("subscription_id","kind","key"),
	CONSTRAINT "subscription_notice_kind_check" CHECK ("subscription_notice"."kind" in ('past_due_started', 'dunning_1', 'dunning_3', 'dunning_5', 'read_only_started', 'recovered')),
	CONSTRAINT "subscription_notice_attempts_check" CHECK ("subscription_notice"."attempts" >= 0),
	CONSTRAINT "subscription_notice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "subscription_notice_subscription_fkey" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscription"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "subscription_notice_unsent_idx" ON "subscription_notice" USING btree ("tenant_id","created_at") WHERE "subscription_notice"."sent_at" is null;
--> statement-breakpoint
ALTER TABLE "subscription_notice" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_notice" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_notice" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The notices are the record of what the owner was told: the application never deletes them.
REVOKE DELETE, TRUNCATE ON "subscription_notice" FROM app_rw;
--> statement-breakpoint
-- What identifies a notice never changes; only the delivery bookkeeping moves, and a notice that was
-- sent stays sent.
CREATE FUNCTION app.subscription_notice_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.key IS DISTINCT FROM OLD.key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'what a notice is about never changes' USING ERRCODE = '23000';
    END IF;
    IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
      RAISE EXCEPTION 'a notice that was sent stays sent' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER subscription_notice_guard BEFORE UPDATE ON "subscription_notice"
  FOR EACH ROW EXECUTE FUNCTION app.subscription_notice_guard();
