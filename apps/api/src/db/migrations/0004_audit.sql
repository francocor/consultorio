CREATE TABLE "audit_event" (
	"id" uuid DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint,
	"actor_user_id" uuid,
	"acting_role" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"patient_id" uuid,
	"outcome" text NOT NULL,
	"reason" text,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "audit_event_tenant_id_occurred_at_id_pk" PRIMARY KEY("tenant_id","occurred_at","id"),
	CONSTRAINT "audit_event_outcome_check" CHECK ("audit_event"."outcome" in ('allow', 'deny')),
	CONSTRAINT "audit_event_seal_check" CHECK (("audit_event"."seq" is null and "audit_event"."prev_hash" is null and "audit_event"."hash" is null)
        or ("audit_event"."seq" is not null and "audit_event"."prev_hash" is not null and "audit_event"."hash" is not null))
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_tenant_time_idx" ON "audit_event" USING btree ("tenant_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_tenant_patient_idx" ON "audit_event" USING btree ("tenant_id","patient_id","occurred_at" DESC NULLS LAST) WHERE "audit_event"."patient_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_event_tenant_actor_idx" ON "audit_event" USING btree ("tenant_id","actor_user_id","occurred_at" DESC NULLS LAST) WHERE "audit_event"."actor_user_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_event_unsealed_idx" ON "audit_event" USING btree ("tenant_id","occurred_at","id") WHERE "audit_event"."seq" is null;--> statement-breakpoint
CREATE INDEX "audit_event_sealed_idx" ON "audit_event" USING btree ("tenant_id","seq" DESC NULLS LAST) WHERE "audit_event"."seq" is not null;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Everything below is hand-written: drizzle-kit cannot express partitions, roles or triggers.
-- ---------------------------------------------------------------------------------------------

-- The sealer role is created by the cluster bootstrap (infra/postgres/init/01-roles.sql) and
-- granted to app_rw with SET but without INHERIT, so the sealer job switches to it explicitly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_sealer') THEN
    RAISE EXCEPTION 'role audit_sealer is missing; run infra/postgres/init/01-roles.sql first';
  END IF;
  IF NOT pg_has_role('app_rw', 'audit_sealer', 'MEMBER') THEN
    RAISE EXCEPTION 'app_rw must be a member of audit_sealer; see infra/postgres/init/01-roles.sql';
  END IF;
END
$$;
--> statement-breakpoint
-- Monthly partitions. SECURITY DEFINER because app_rw cannot create tables: the function runs as
-- the owner. The boundaries are UTC midnights, whatever the session time zone is. The runtime
-- role gets no access to the partitions themselves, only to the parent, where row level security
-- and the append-only triggers apply.
CREATE FUNCTION app.ensure_audit_partitions(months_ahead integer DEFAULT 3, from_month date DEFAULT current_date)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    first_month date := date_trunc('month', from_month)::date;
    start_at date;
    end_at date;
    part text;
    created integer := 0;
  BEGIN
    IF months_ahead < 0 OR months_ahead > 36 THEN
      RAISE EXCEPTION 'months_ahead must be between 0 and 36';
    END IF;
    FOR i IN 0..months_ahead LOOP
      start_at := (first_month + make_interval(months => i))::date;
      end_at := (start_at + interval '1 month')::date;
      part := format('audit_event_%s', to_char(start_at, 'YYYY_MM'));
      IF to_regclass(format('public.%I', part)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE public.%I PARTITION OF public.audit_event FOR VALUES FROM (%L) TO (%L)',
          part, start_at::text || ' 00:00:00+00', end_at::text || ' 00:00:00+00'
        );
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, app_rw', part);
        created := created + 1;
      END IF;
    END LOOP;
    RETURN created;
  END
  $$;
--> statement-breakpoint
-- app_rw may INSERT and SELECT audit events and nothing else.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "audit_event" FROM app_rw;
--> statement-breakpoint
-- The sealer reads events and fills the three seal columns. It cannot insert or delete.
GRANT USAGE ON SCHEMA public TO audit_sealer;
--> statement-breakpoint
GRANT SELECT ON "audit_event" TO audit_sealer;
--> statement-breakpoint
GRANT UPDATE ("seq", "prev_hash", "hash") ON "audit_event" TO audit_sealer;
--> statement-breakpoint
-- Append-only guard. DELETE is never allowed. UPDATE is allowed only to the audit_sealer role, and
-- only to fill seq, prev_hash and hash, all three, from NULL, leaving every other column as it was.
CREATE FUNCTION app.audit_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'audit_event is append-only: rows cannot be deleted';
    END IF;
    IF current_user <> 'audit_sealer' THEN
      RAISE EXCEPTION 'audit_event is append-only: rows cannot be updated';
    END IF;
    IF OLD.seq IS NOT NULL OR OLD.prev_hash IS NOT NULL OR OLD.hash IS NOT NULL THEN
      RAISE EXCEPTION 'audit_event row is already sealed';
    END IF;
    IF NEW.seq IS NULL OR NEW.prev_hash IS NULL OR NEW.hash IS NULL THEN
      RAISE EXCEPTION 'audit_event seal must set seq, prev_hash and hash together';
    END IF;
    IF (to_jsonb(NEW) - 'seq' - 'prev_hash' - 'hash') IS DISTINCT FROM (to_jsonb(OLD) - 'seq' - 'prev_hash' - 'hash') THEN
      RAISE EXCEPTION 'audit_event seal may only fill seq, prev_hash and hash';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_guard
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_guard();
--> statement-breakpoint
-- Row level security on the parent. Partitions are reachable only through it (no grants).
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_event" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The current month and the three after it. A job keeps creating the following ones.
SELECT app.ensure_audit_partitions(3);
