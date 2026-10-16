CREATE TABLE "operator_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "operator_user" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_dek_wrapped" "bytea" NOT NULL,
	"totp_secret_enc" "bytea" NOT NULL,
	"totp_last_step" bigint,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_user_status_check" CHECK ("operator_user"."status" in ('active', 'disabled')),
	CONSTRAINT "operator_user_failed_logins_check" CHECK ("operator_user"."failed_logins" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint,
	"operator_id" uuid,
	"target_tenant_id" uuid,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"resource_type" text,
	"resource_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "platform_audit_event_outcome_check" CHECK ("platform_audit_event"."outcome" in ('allow', 'deny')),
	CONSTRAINT "platform_audit_event_seal_check" CHECK (("platform_audit_event"."seq" is null and "platform_audit_event"."prev_hash" is null and "platform_audit_event"."hash" is null)
        or ("platform_audit_event"."seq" is not null and "platform_audit_event"."prev_hash" is not null and "platform_audit_event"."hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "support_grant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" text DEFAULT 'administrative' NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "support_grant_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_grant_scope_check" CHECK ("support_grant"."scope" = 'administrative'),
	CONSTRAINT "support_grant_window_check" CHECK ("support_grant"."expires_at" > "support_grant"."starts_at"),
	CONSTRAINT "support_grant_max_window_check" CHECK ("support_grant"."expires_at" <= "support_grant"."starts_at" + interval '7 days'),
	CONSTRAINT "support_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "operator_session" ADD CONSTRAINT "operator_session_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."operator_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_session_token_hash_key" ON "operator_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_session_operator_idx" ON "operator_session" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_user_email_key" ON "operator_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_event_seq_key" ON "platform_audit_event" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "platform_audit_event_time_idx" ON "platform_audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_event_tenant_idx" ON "platform_audit_event" USING btree ("target_tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "support_grant_tenant_idx" ON "support_grant" USING btree ("tenant_id","expires_at");
--> statement-breakpoint
ALTER TABLE "support_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_grant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_grant" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Everything below is hand-written: roles, privileges, policies, triggers and functions.
-- ---------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_operator') THEN
    RAISE EXCEPTION 'role app_operator is missing; run infra/postgres/init/01-roles.sql first (existing local databases: pnpm infra:reset)';
  END IF;
END
$$;
--> statement-breakpoint
-- The operator tables belong to the operator console. The application role cannot even see them:
-- a bug or an injection in the tenant API cannot reach operator credentials or the platform trail.
REVOKE ALL ON "operator_user", "operator_session", "platform_audit_event" FROM app_rw;
--> statement-breakpoint
-- A grant is created and revoked by the organization, never edited, and never deleted.
REVOKE DELETE, TRUNCATE ON "support_grant" FROM app_rw;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- app_operator: an allowlist. It can run the console and touch the tenant row, a few tenant
-- bootstrap tables and (only under a support grant) administrative configuration. It has NO
-- privilege on any clinical, patient, staff or scheduling table: the privilege test lists them.
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO app_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.uuid_v7() TO app_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON "operator_user" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("totp_last_step", "failed_logins", "last_failed_at", "locked_until", "updated_at")
  ON "operator_user" TO app_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON "operator_session" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("last_seen_at", "revoked_at", "revoked_reason") ON "operator_session" TO app_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON "platform_audit_event" TO app_operator;
--> statement-breakpoint
-- The platform trail is append-only and sealed by the same role and the same rules as the tenant
-- trails: the append-only trigger of audit_event is generic (it compares everything but the seal).
GRANT SELECT ON "platform_audit_event" TO audit_sealer;
--> statement-breakpoint
GRANT UPDATE ("seq", "prev_hash", "hash") ON "platform_audit_event" TO audit_sealer;
--> statement-breakpoint
CREATE INDEX "platform_audit_event_unsealed_idx" ON "platform_audit_event" USING btree ("occurred_at","id") WHERE "seq" IS NULL;
--> statement-breakpoint
CREATE TRIGGER platform_audit_event_guard
  BEFORE UPDATE OR DELETE ON "platform_audit_event"
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_guard();
--> statement-breakpoint
-- The tenant row: create it, and read the non-sensitive columns of every tenant (the console lists
-- them). The settings column is not readable, and nothing is updatable: `is_demo` is fixed at
-- creation and the operator never edits an organization.
GRANT INSERT ON "tenant" TO app_operator;
--> statement-breakpoint
GRANT SELECT ("id", "slug", "status", "read_only_since", "is_demo", "billing_exempt", "country", "theme", "created_at", "updated_at")
  ON "tenant" TO app_operator;
--> statement-breakpoint
CREATE POLICY "operator_directory" ON "tenant" FOR SELECT TO app_operator USING (true);
--> statement-breakpoint
-- Creating an organization: its data key and its owner invitation.
GRANT INSERT ON "tenant_key" TO app_operator;
--> statement-breakpoint
GRANT SELECT ("tenant_id", "purpose", "version", "status") ON "tenant_key" TO app_operator;
--> statement-breakpoint
GRANT INSERT ON "action_token" TO app_operator;
--> statement-breakpoint
GRANT SELECT ("id", "kind", "revoked_at", "uses", "max_uses") ON "action_token" TO app_operator;
--> statement-breakpoint
-- Re-issuing the first owner invitation cancels the ones still outstanding (a mistyped address).
GRANT UPDATE ("revoked_at", "updated_at") ON "action_token" TO app_operator;
--> statement-breakpoint
GRANT INSERT ON "audit_event" TO app_operator;
--> statement-breakpoint
-- Administrative configuration, readable only while a support grant is active (policies below).
GRANT SELECT ON "location", "tenant_feature" TO app_operator;
--> statement-breakpoint
-- Matricula verification (migration 0013 granted the three columns it sets). Drizzle also stamps
-- updated_at on every update, so the operator may touch that column too.
GRANT UPDATE ("updated_at") ON "professional" TO app_operator;
--> statement-breakpoint
-- The grant that is open right now for an organization (id and end), or no row. SECURITY DEFINER
-- because the operator role has no privilege on support_grant at all. Like every tenant function it
-- sees only the rows of the transaction's own tenant.
CREATE FUNCTION app.active_support_grant(p_tenant uuid) RETURNS TABLE (id uuid, expires_at timestamp with time zone)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT g.id, g.expires_at
      FROM public.support_grant g
     WHERE g.tenant_id = p_tenant
       AND g.revoked_at IS NULL
       AND g.starts_at <= now()
       AND g.expires_at > now()
     ORDER BY g.expires_at DESC
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.active_support_grant(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.active_support_grant(uuid) TO app_operator;
--> statement-breakpoint
CREATE FUNCTION app.active_support_grant_id(p_tenant uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT g.id FROM app.active_support_grant(p_tenant) g
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.active_support_grant_id(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.active_support_grant_id(uuid) TO app_operator;
--> statement-breakpoint
-- True while an organization has no member at all. The operator may issue the FIRST owner
-- invitation of a new organization and nothing else: once anyone has joined, the organization
-- governs its own staff.
CREATE FUNCTION app.tenant_is_unclaimed(p_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT NOT EXISTS (SELECT 1 FROM public.membership m WHERE m.tenant_id = p_tenant)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_is_unclaimed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_is_unclaimed(uuid) TO app_operator;
--> statement-breakpoint
CREATE POLICY "operator_needs_support_grant" ON "location" AS RESTRICTIVE FOR SELECT TO app_operator
  USING (app.active_support_grant_id("tenant_id") IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "operator_needs_support_grant" ON "tenant_feature" AS RESTRICTIVE FOR SELECT TO app_operator
  USING (app.active_support_grant_id("tenant_id") IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "operator_owner_invitation_only" ON "action_token" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK ("kind" = 'staff_invitation' AND app.tenant_is_unclaimed("tenant_id"));
--> statement-breakpoint
CREATE POLICY "operator_owner_invitation_revoke" ON "action_token" AS RESTRICTIVE FOR UPDATE TO app_operator
  USING ("kind" = 'staff_invitation' AND app.tenant_is_unclaimed("tenant_id"))
  WITH CHECK ("kind" = 'staff_invitation' AND app.tenant_is_unclaimed("tenant_id"));
--> statement-breakpoint
CREATE POLICY "operator_audit_scope" ON "audit_event" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK ("action" IN ('tenant.created', 'support.access'));
