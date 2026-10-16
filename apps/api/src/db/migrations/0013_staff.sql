-- The platform operator is a database role of its own (infra/postgres/init/01-roles.sql). The
-- verification of a matricula belongs to it and to nobody else, so this migration needs it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_operator') THEN
    RAISE EXCEPTION 'role app_operator is missing; run infra/postgres/init/01-roles.sql first (existing local databases: pnpm infra:reset)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "professional" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"matricula" text,
	"matricula_jurisdiction" text,
	"matricula_status" text DEFAULT 'unverified' NOT NULL,
	"verified_by_operator" uuid,
	"verified_at" timestamp with time zone,
	"max_simultaneous" smallint DEFAULT 1 NOT NULL,
	"specialties" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "professional_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "professional_tenant_id_membership_id_key" UNIQUE("tenant_id","membership_id"),
	CONSTRAINT "professional_status_check" CHECK ("professional"."status" in ('active', 'inactive')),
	CONSTRAINT "professional_matricula_status_check" CHECK ("professional"."matricula_status" in ('unverified', 'verified')),
	CONSTRAINT "professional_matricula_pair_check" CHECK (("professional"."matricula" is null) = ("professional"."matricula_jurisdiction" is null)),
	CONSTRAINT "professional_verified_check" CHECK ("professional"."matricula_status" = 'unverified' or ("professional"."matricula" is not null and "professional"."verified_by_operator" is not null)),
	CONSTRAINT "professional_max_simultaneous_check" CHECK ("professional"."max_simultaneous" between 1 and 20),
	CONSTRAINT "professional_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "professional_membership_fkey" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "professional_hours" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"professional_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_minute" smallint NOT NULL,
	"end_minute" smallint NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "professional_hours_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "professional_hours_weekday_check" CHECK ("professional_hours"."weekday" between 1 and 7),
	CONSTRAINT "professional_hours_interval_check" CHECK ("professional_hours"."start_minute" >= 0 and "professional_hours"."end_minute" <= 1440 and "professional_hours"."end_minute" > "professional_hours"."start_minute"),
	CONSTRAINT "professional_hours_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "professional_hours_location_fkey" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "professional_hours" ADD CONSTRAINT "professional_hours_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "professional_matricula_active_key" ON "professional" USING btree ("tenant_id","matricula_jurisdiction","matricula") WHERE "professional"."status" = 'active' and "professional"."matricula" is not null;--> statement-breakpoint
CREATE INDEX "professional_hours_live_idx" ON "professional_hours" USING btree ("tenant_id","professional_id") WHERE "professional_hours"."removed_at" is null;--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "professional" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "professional" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "professional" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "professional_hours" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "professional_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "professional_hours" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Verifying a matricula is the platform operator's job (staff-professionals, "Matricula uniqueness
-- and validation state"). The trigger runs as the invoking role, so `current_user` is app_rw for
-- every tenant user, owners and admins included, and nothing in the application can verify.
--   * A row can only become `verified` when the statement runs as app_operator.
--   * Editing the number or the jurisdiction puts the row back to `unverified`, unless the operator
--     is the one editing.
--   * Nobody but the operator can change who verified it, or when.
CREATE FUNCTION app.guard_matricula_status() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'app_operator' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.matricula_status <> 'unverified' OR NEW.verified_by_operator IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
        RAISE EXCEPTION 'only the platform operator verifies a matricula' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.matricula_status = 'verified' AND OLD.matricula_status <> 'verified' THEN
      RAISE EXCEPTION 'only the platform operator verifies a matricula' USING ERRCODE = '42501';
    END IF;
    IF NEW.verified_by_operator IS DISTINCT FROM OLD.verified_by_operator
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
      IF NOT (NEW.matricula_status = 'unverified' AND NEW.verified_by_operator IS NULL AND NEW.verified_at IS NULL) THEN
        RAISE EXCEPTION 'only the platform operator verifies a matricula' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.matricula IS DISTINCT FROM OLD.matricula
       OR NEW.matricula_jurisdiction IS DISTINCT FROM OLD.matricula_jurisdiction THEN
      NEW.matricula_status := 'unverified';
      NEW.verified_by_operator := NULL;
      NEW.verified_at := NULL;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER professional_guard_matricula_status
  BEFORE INSERT OR UPDATE ON "professional"
  FOR EACH ROW EXECUTE FUNCTION app.guard_matricula_status();
--> statement-breakpoint
-- The operator may read profiles and write ONLY the three verification columns.
GRANT USAGE ON SCHEMA public TO app_operator;
--> statement-breakpoint
GRANT SELECT ON "professional" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("matricula_status", "verified_by_operator", "verified_at") ON "professional" TO app_operator;
--> statement-breakpoint
-- The care tables name a professional (S1.17 left the columns without keys). The tenant tables are
-- FORCE row level secured, so validating a new key needs a tenant context a migration does not
-- have: a nil tenant makes the policies see no rows, and the tables are empty at this point (no
-- route writes a care assignment before the patient tables exist).
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
--> statement-breakpoint
ALTER TABLE "care_assignment" ADD CONSTRAINT "care_assignment_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "care_relationship" ADD CONSTRAINT "care_relationship_professional_fkey" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id");
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
