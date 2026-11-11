-- The portal's own accounts (Stage 5, track B): an identity per person and organization, the links
-- that say whose record it may read, and the sessions of its cookie. Nothing here is ever deleted
-- (an account is deactivated, a link revoked, a session ended), so the application role loses
-- DELETE and TRUNCATE on all three. The `otp_challenge.purpose` check already lists
-- `portal_registration` and `portal_sign_in` since 0341, so the expand the task names was done there.
CREATE TABLE "portal_identity" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" "citext" NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_patient_id" uuid,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	CONSTRAINT "portal_identity_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "portal_identity_tenant_id_email_key" UNIQUE("tenant_id","email"),
	CONSTRAINT "portal_identity_status_check" CHECK ("portal_identity"."status" in ('invited', 'active', 'deactivated')),
	CONSTRAINT "portal_identity_activated_check" CHECK ("portal_identity"."status" <> 'active' or "portal_identity"."activated_at" is not null),
	CONSTRAINT "portal_identity_deactivated_check" CHECK (("portal_identity"."status" = 'deactivated') = ("portal_identity"."deactivated_at" is not null)),
	CONSTRAINT "portal_identity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "portal_identity_invited_patient_fkey" FOREIGN KEY ("tenant_id","invited_patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "portal_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"portal_identity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"relation" text,
	"verification_note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"majority_review_on" date,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	CONSTRAINT "portal_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "portal_link_relationship_check" CHECK ("portal_link"."relationship" in ('self', 'representative')),
	CONSTRAINT "portal_link_status_check" CHECK ("portal_link"."status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "portal_link_relation_check" CHECK (("portal_link"."relationship" = 'representative') = ("portal_link"."relation" is not null)
        and ("portal_link"."relation" is null or "portal_link"."relation" in ('mother', 'father', 'guardian', 'other'))),
	CONSTRAINT "portal_link_verification_check" CHECK ("portal_link"."relationship" = 'self' or "portal_link"."verification_note" is not null),
	CONSTRAINT "portal_link_revoked_check" CHECK (("portal_link"."status" = 'revoked') = ("portal_link"."revoked_at" is not null)),
	CONSTRAINT "portal_link_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "portal_link_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "portal_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"portal_identity_id" uuid NOT NULL,
	"selected_link_id" uuid,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" uuid,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "portal_session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "portal_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_identity_fkey" FOREIGN KEY ("tenant_id","portal_identity_id") REFERENCES "public"."portal_identity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_identity_fkey" FOREIGN KEY ("tenant_id","portal_identity_id") REFERENCES "public"."portal_identity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_link_fkey" FOREIGN KEY ("tenant_id","selected_link_id") REFERENCES "public"."portal_link"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_identity_invited_patient_idx" ON "portal_identity" USING btree ("tenant_id","invited_patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_self_identity_key" ON "portal_link" USING btree ("tenant_id","portal_identity_id") WHERE "portal_link"."relationship" = 'self' and "portal_link"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_self_patient_key" ON "portal_link" USING btree ("tenant_id","patient_id") WHERE "portal_link"."relationship" = 'self' and "portal_link"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_pair_key" ON "portal_link" USING btree ("tenant_id","portal_identity_id","patient_id") WHERE "portal_link"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "portal_link_patient_idx" ON "portal_link" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "portal_link_majority_idx" ON "portal_link" USING btree ("majority_review_on") WHERE "portal_link"."status" = 'active' and "portal_link"."majority_review_on" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_session_token_hash_key" ON "portal_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_session_identity_idx" ON "portal_session" USING btree ("tenant_id","portal_identity_id") WHERE "portal_session"."revoked_at" is null;
--> statement-breakpoint
ALTER TABLE "portal_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_identity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal_identity" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "portal_link" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_link" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal_link" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "portal_session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal_session" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "portal_identity" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "portal_link" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "portal_session" FROM app_rw;
