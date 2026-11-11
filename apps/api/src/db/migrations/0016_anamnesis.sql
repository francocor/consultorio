CREATE TABLE "anamnesis" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	"content_enc" "bytea" NOT NULL,
	CONSTRAINT "anamnesis_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "anamnesis_tenant_id_patient_id_version_key" UNIQUE("tenant_id","patient_id","version"),
	CONSTRAINT "anamnesis_version_check" CHECK ("anamnesis"."version" >= 1),
	CONSTRAINT "anamnesis_visibility_check" CHECK ("anamnesis"."visibility" = 'default'),
	CONSTRAINT "anamnesis_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "anamnesis_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "anamnesis_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "anamnesis_latest_idx" ON "anamnesis" USING btree ("tenant_id","patient_id","version");
--> statement-breakpoint
ALTER TABLE "anamnesis" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "anamnesis" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "anamnesis" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Clinical backstop (ADR-003): on top of tenant isolation, only a health professional's transaction
-- sees any row, and only the rows the care relationship and the sharing scope allow. Anamnesis
-- follows the general ceiling (no template kind).
CREATE POLICY "clinical_professionals_only" ON "anamnesis" AS RESTRICTIVE USING (nullif(current_setting('app.professional_id', true), '') IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "anamnesis" AS RESTRICTIVE USING (app.clinical_readable("patient_id", "author_professional_id", "visibility", NULL::text));
--> statement-breakpoint
-- Versions are immutable: a correction is a new version, never an overwrite or a deletion.
REVOKE UPDATE, DELETE, TRUNCATE ON "anamnesis" FROM app_rw;
--> statement-breakpoint
-- The safety flag of a patient (codes only) follows the anamnesis and nothing else. It is written
-- by this one function, which a professional's transaction calls right after saving the anamnesis.
-- The trigger below rejects every other write: no endpoint, no tenant user and no other statement
-- can set or clear a flag by hand (patients, "Safety alerts without clinical detail").
CREATE FUNCTION app.set_patient_safety_flags(p_tenant uuid, p_patient uuid, p_codes text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed text[] := ARRAY['allergy_on_file', 'anticoagulant_on_file', 'pregnancy', 'implanted_device'];
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'safety flags of another tenant' USING ERRCODE = '42501';
  END IF;
  IF nullif(current_setting('app.professional_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'only a health professional recomputes safety flags' USING ERRCODE = '42501';
  END IF;
  IF NOT (p_codes <@ allowed) THEN
    RAISE EXCEPTION 'unknown safety flag code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.patient
     SET safety_flags = coalesce((SELECT array_agg(DISTINCT code ORDER BY code) FROM unnest(p_codes) AS code), '{}'::text[]),
         updated_at = now()
   WHERE tenant_id = p_tenant AND id = p_patient;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'P0002';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app.guard_safety_flags() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- Inside app.set_patient_safety_flags the statement runs as its owner, the migration role.
    IF current_user = 'app_owner' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF cardinality(NEW.safety_flags) > 0 THEN
        RAISE EXCEPTION 'safety flags are maintained by the system' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.safety_flags IS DISTINCT FROM OLD.safety_flags THEN
      RAISE EXCEPTION 'safety flags are maintained by the system' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER patient_guard_safety_flags
  BEFORE INSERT OR UPDATE ON "patient"
  FOR EACH ROW EXECUTE FUNCTION app.guard_safety_flags();
