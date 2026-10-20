CREATE TABLE "signup_pending" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_email" "citext" NOT NULL,
	"owner_name" text NOT NULL,
	"password_hash" text,
	"terms_version" integer NOT NULL,
	"data_processing_version" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"verification_sent_at" timestamp with time zone,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"last_send_attempt_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "signup_pending_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "signup_pending_tenant_id_key" UNIQUE("tenant_id"),
	CONSTRAINT "signup_pending_hash_check" CHECK (("signup_pending"."verified_at" is null) = ("signup_pending"."password_hash" is not null)),
	CONSTRAINT "signup_pending_attempts_check" CHECK ("signup_pending"."send_attempts" >= 0),
	CONSTRAINT "signup_pending_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "terms_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" integer NOT NULL,
	"data_processing_version" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "terms_acceptance_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "terms_acceptance_versions_check" CHECK ("terms_acceptance"."terms_version" >= 1 and "terms_acceptance"."data_processing_version" >= 1),
	CONSTRAINT "terms_acceptance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "terms_acceptance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id")
);
--> statement-breakpoint
CREATE TABLE "terms_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_version_kind_version_key" UNIQUE("kind","version"),
	CONSTRAINT "terms_version_kind_check" CHECK ("terms_version"."kind" in ('terms', 'data_processing')),
	CONSTRAINT "terms_version_version_check" CHECK ("terms_version"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tenant" DROP CONSTRAINT "tenant_status_check";--> statement-breakpoint
CREATE UNIQUE INDEX "signup_pending_email_key" ON "signup_pending" USING btree ("owner_email") WHERE "signup_pending"."verified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "terms_version_current_key" ON "terms_version" USING btree ("kind") WHERE "terms_version"."is_current";--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_status_check" CHECK ("tenant"."status" in ('active', 'read_only', 'cancelled', 'unverified')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "signup_pending" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "signup_pending" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "signup_pending" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "terms_acceptance" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "terms_acceptance" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "terms_acceptance" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Everything below is hand-written: seed, privileges, policies and functions (Stage 6, S6.02).
-- ---------------------------------------------------------------------------------------------

-- The first versions of the two documents a signup accepts. A platform table: every organization
-- reads it, only the owner connection writes it (publishing a version is a data change).
INSERT INTO "terms_version" ("kind", "version", "is_current") VALUES ('terms', 1, true), ('data_processing', 1, true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "terms_version" FROM app_rw;
--> statement-breakpoint
-- An acceptance is a fact: written once, never edited or removed.
REVOKE UPDATE, DELETE, TRUNCATE ON "terms_acceptance" FROM app_rw;
--> statement-breakpoint
-- A pending signup is changed (the email was sent, the address was confirmed) but never deleted by
-- the runtime role: the purge of unverified signups is the function below.
REVOKE DELETE, TRUNCATE ON "signup_pending" FROM app_rw;
--> statement-breakpoint
-- The functions below run as the owner, which is subject to FORCE row level security: this policy
-- lets them read the pending signups of every organization (the runtime role gets nothing beyond
-- its tenant policy).
CREATE POLICY "signup_pending_owner_lookup" ON "signup_pending" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
-- What a signup address is today: an account that exists (`account`), a signup still waiting for its
-- link (`pending`, with its organization), or free (no row). The signup answers a visitor the same
-- in every case; this is how it knows what to do behind the answer. It returns an organization id
-- and nothing else: no name, no person.
CREATE FUNCTION app.signup_email_state(p_email citext)
RETURNS TABLE (state text, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.state, s.tenant_id
    FROM (
      SELECT 'account'::text AS state, NULL::uuid AS tenant_id, 0 AS rank
        FROM public.user_account u
       WHERE u.email = p_email
      UNION ALL
      SELECT 'pending'::text, p.tenant_id, 1
        FROM public.signup_pending p
       WHERE p.owner_email = p_email AND p.verified_at IS NULL
    ) s
   ORDER BY s.rank
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.signup_email_state(citext) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.signup_email_state(citext) TO app_rw;
--> statement-breakpoint
-- The audit guard of migration 0018 with one more narrow exception: a DELETE by the migration owner,
-- inside app.signup_purge, for the organization named by `app.signup_purge` and only while that
-- organization is still `unverified`. The trail of an organization that never became one goes with
-- it; nothing else about the rule changes.
CREATE OR REPLACE FUNCTION app.audit_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF (to_jsonb(OLD) ? 'tenant_id')
         AND current_user = 'app_owner'
         AND current_setting('app.demo_reset', true) = (to_jsonb(OLD) ->> 'tenant_id')
         AND EXISTS (SELECT 1 FROM public.tenant t WHERE t.id::text = (to_jsonb(OLD) ->> 'tenant_id') AND t.is_demo) THEN
        RETURN OLD;
      END IF;
      IF (to_jsonb(OLD) ? 'tenant_id')
         AND current_user = 'app_owner'
         AND current_setting('app.signup_purge', true) = (to_jsonb(OLD) ->> 'tenant_id')
         AND EXISTS (SELECT 1 FROM public.tenant t WHERE t.id::text = (to_jsonb(OLD) ->> 'tenant_id') AND t.status = 'unverified') THEN
        RETURN OLD;
      END IF;
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
-- The purge of unverified signups (retention exception 2 of the tenancy rule). It removes an
-- organization that was never confirmed, with what it holds, and records in the PLATFORM trail that
-- it did (the organization's own trail goes with it). The guarantees are in the function and the
-- schema, not in whoever calls it:
--   * only an organization whose status is `unverified` and that is older than the cutoff, and the
--     cutoff can never be younger than a day, so a caller cannot use it on a fresh signup;
--   * what it deletes is a fixed list (the pending signup, its links, the job markers, the trail);
--     any other row that points at the organization (a member, a patient, a key) makes the delete of
--     the organization fail with a foreign key violation, the organization is left as it was and the
--     next one is tried, so it cannot take clinical data or a verified organization with it;
--   * at most p_limit (never more than 500) organizations per call.
-- It runs as the owner but under the tenant context of each organization in turn (row level security
-- stays FORCED; no table is ever unprotected). The runtime role runs it from the worker.
CREATE FUNCTION app.signup_purge(p_older_than timestamp with time zone, p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cutoff timestamp with time zone := LEAST(p_older_than, now() - interval '1 day');
  v_ids uuid[];
  v_id uuid;
  v_age integer;
  v_purged integer := 0;
BEGIN
  -- Listing the candidates is a platform scan of the organizations table (policy tenant_platform_scan).
  PERFORM set_config('app.scope', 'platform', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
  SELECT coalesce(array_agg(c.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT t.id
        FROM public.tenant t
       WHERE t.status = 'unverified' AND t.created_at < v_cutoff
       ORDER BY t.created_at
       LIMIT greatest(least(p_limit, 500), 0)
    ) c;

  FOREACH v_id IN ARRAY v_ids LOOP
    BEGIN
      PERFORM set_config('app.tenant_id', v_id::text, true);
      PERFORM set_config('app.signup_purge', v_id::text, true);
      SELECT floor(extract(epoch FROM now() - t.created_at) / 86400)::integer INTO v_age
        FROM public.tenant t WHERE t.id = v_id AND t.status = 'unverified';
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      DELETE FROM public.signup_pending WHERE tenant_id = v_id;
      DELETE FROM public.action_token WHERE tenant_id = v_id;
      DELETE FROM public.job_execution WHERE tenant_id = v_id;
      DELETE FROM public.audit_event WHERE tenant_id = v_id;
      DELETE FROM public.tenant WHERE id = v_id AND status = 'unverified';
      INSERT INTO public.platform_audit_event
        (operator_id, target_tenant_id, action, outcome, resource_type, resource_id, metadata)
      VALUES
        (NULL, v_id, 'signup.purged', 'allow', 'tenant', v_id, jsonb_build_object('ageDays', v_age));
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- Something else points at it: it is not a bare signup, so it stays.
      NULL;
    END;
  END LOOP;

  PERFORM set_config('app.signup_purge', '', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
  RETURN v_purged;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.signup_purge(timestamp with time zone, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.signup_purge(timestamp with time zone, integer) TO app_rw;
--> statement-breakpoint
-- The operator console lists the organizations; a signup nobody confirmed is not one yet, and the
-- only thing it holds is the personal data of a person who has not proved their address. The
-- console does not see it (nor is it asked to act on it: the purge removes it).
DROP POLICY "operator_directory" ON "tenant";
--> statement-breakpoint
CREATE POLICY "operator_directory" ON "tenant" FOR SELECT TO app_operator USING ("status" <> 'unverified');
