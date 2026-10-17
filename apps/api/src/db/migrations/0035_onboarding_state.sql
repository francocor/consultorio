CREATE TABLE "onboarding_state" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"step_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_step" text,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wizard_completed_at" timestamp with time zone,
	"wizard_completed_by" uuid,
	"checklist_dismissed_at" timestamp with time zone,
	"checklist_dismissed_by" uuid,
	CONSTRAINT "onboarding_state_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_state_current_step_check" CHECK ("onboarding_state"."current_step" is null or "onboarding_state"."current_step" in ('profile', 'location', 'hours', 'appointment_types', 'team', 'branding', 'billing')),
	CONSTRAINT "onboarding_state_completed_check" CHECK (("onboarding_state"."wizard_completed_at" is null) = ("onboarding_state"."wizard_completed_by" is null)),
	CONSTRAINT "onboarding_state_dismissed_check" CHECK (("onboarding_state"."checklist_dismissed_at" is null) = ("onboarding_state"."checklist_dismissed_by" is null)),
	CONSTRAINT "onboarding_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_state_tenant_key" ON "onboarding_state" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "onboarding_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "onboarding_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_state" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Progress is finished and dismissed with an author, never deleted (tenancy, "No deletion").
REVOKE DELETE, TRUNCATE ON "onboarding_state" FROM app_rw;
