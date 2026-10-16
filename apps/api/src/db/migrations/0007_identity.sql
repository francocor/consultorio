-- Identity: accounts, memberships, sessions, login challenges and recovery codes.
--
-- Foreign keys are declared inline. `tenant` and `user_account` have FORCE row level security
-- (the owner included), so adding them afterwards with ALTER TABLE needs a context a migration
-- does not have. Referential integrity checks themselves bypass row level security.
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"totp_secret_enc" "bytea",
	"totp_tenant_id" uuid,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_step" bigint,
	"first_sign_in_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_account_email_key" UNIQUE("email"),
	CONSTRAINT "user_account_failed_logins_check" CHECK ("user_account"."failed_logins" >= 0)
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"roles" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "membership_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "membership_tenant_id_user_id_key" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "membership_roles_check" CHECK (cardinality("membership"."roles") > 0 and "membership"."roles" <@ array['owner','admin','professional','reception']::text[]),
	CONSTRAINT "membership_status_check" CHECK ("membership"."status" in ('active', 'deactivated')),
	CONSTRAINT "membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text DEFAULT 'full' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "session_scope_check" CHECK ("session"."scope" in ('full', 'two_factor_enrollment')),
	CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id"),
	CONSTRAINT "session_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "login_challenge" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "login_challenge_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "login_challenge_attempts_check" CHECK ("login_challenge"."attempts" >= 0),
	CONSTRAINT "login_challenge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "login_challenge_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id"),
	CONSTRAINT "login_challenge_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "recovery_code" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "login_challenge_token_hash_key" ON "login_challenge" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "recovery_code_user_idx" ON "recovery_code" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("tenant_id","user_id") WHERE "session"."revoked_at" is null;
--> statement-breakpoint
-- Tenant tables: the standard isolation policy.
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "session" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "login_challenge" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "login_challenge" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "login_challenge" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Memberships are deactivated, never deleted.
REVOKE DELETE, TRUNCATE ON "membership" FROM app_rw;
--> statement-breakpoint
-- user_account has no tenant_id. A transaction sees an account if it IS that user (app.user_id) or
-- the account has a membership in the transaction's tenant. It can only insert or update the
-- account it acts as, so an administrator cannot touch a colleague's password hash or lock
-- counters. Accounts are never deleted by the runtime role.
ALTER TABLE "user_account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_account" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_select" ON "user_account" FOR SELECT
  USING (
    "id" = nullif(current_setting('app.user_id'), '')::uuid
    OR EXISTS (
      SELECT 1 FROM "membership" m
       WHERE m."user_id" = "user_account"."id"
         AND m."tenant_id" = current_setting('app.tenant_id')::uuid
    )
  );
--> statement-breakpoint
CREATE POLICY "user_insert" ON "user_account" FOR INSERT
  WITH CHECK ("id" = nullif(current_setting('app.user_id'), '')::uuid);
--> statement-breakpoint
CREATE POLICY "user_update" ON "user_account" FOR UPDATE
  USING ("id" = nullif(current_setting('app.user_id'), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.user_id'), '')::uuid);
--> statement-breakpoint
-- The login lookup runs as the function owner (SECURITY DEFINER), so this policy is for app_owner
-- only: the runtime role can reach an account it knows nothing about ONLY through the function.
CREATE POLICY "user_login_lookup" ON "user_account" FOR SELECT TO app_owner USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "user_account" FROM app_rw;
--> statement-breakpoint
-- Recovery codes belong to one user; only that user's own transaction sees them.
ALTER TABLE "recovery_code" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recovery_code" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recovery_code_own" ON "recovery_code"
  USING ("user_id" = nullif(current_setting('app.user_id'), '')::uuid)
  WITH CHECK ("user_id" = nullif(current_setting('app.user_id'), '')::uuid);
--> statement-breakpoint
-- Finds an account by email before any user or tenant is known (sign-in, password reset request,
-- invitation acceptance). It returns the minimum the caller needs and nothing else: no TOTP data,
-- no email, no tenant information.
CREATE FUNCTION app.lookup_user_for_login(p_email citext)
RETURNS TABLE (
  id uuid,
  password_hash text,
  failed_logins integer,
  last_failed_at timestamp with time zone,
  locked_until timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.password_hash, u.failed_logins, u.last_failed_at, u.locked_until
    FROM public.user_account u
   WHERE u.email = p_email
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lookup_user_for_login(citext) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_user_for_login(citext) TO app_rw;
