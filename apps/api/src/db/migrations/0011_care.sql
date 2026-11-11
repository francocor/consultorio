CREATE TABLE "care_assignment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "care_assignment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "care_relationship" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"qualifying_appointments" integer DEFAULT 0 NOT NULL,
	"encounters" integer DEFAULT 0 NOT NULL,
	"assigned" boolean DEFAULT false NOT NULL,
	"active" boolean GENERATED ALWAYS AS (qualifying_appointments > 0 or encounters > 0 or assigned) STORED NOT NULL,
	CONSTRAINT "care_relationship_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_relationship_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "care_assignment_live_idx" ON "care_assignment" USING btree ("tenant_id","patient_id","professional_id") WHERE "care_assignment"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "care_assignment_patient_idx" ON "care_assignment" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "care_relationship_pair_key" ON "care_relationship" USING btree ("tenant_id","patient_id","professional_id");--> statement-breakpoint
CREATE INDEX "care_relationship_active_idx" ON "care_relationship" USING btree ("tenant_id","professional_id","patient_id") WHERE "care_relationship"."active";
--> statement-breakpoint
ALTER TABLE "care_assignment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "care_assignment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "care_assignment" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "care_relationship" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "care_relationship" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "care_relationship" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The care relationship decides who may read clinical content, so application code must not be
-- able to write it. The runtime role gets read access only; the rows are maintained by the
-- SECURITY DEFINER functions below, which triggers call. Assignments are ended, never deleted.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "care_relationship" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "care_assignment" FROM app_rw;
--> statement-breakpoint
-- Sets whether a pair has a live explicit assignment. Only for the current tenant of the
-- transaction: it cannot be used to touch another tenant's relationships.
CREATE FUNCTION app.care_set_assigned(p_tenant uuid, p_patient uuid, p_professional uuid, p_assigned boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'care relationship of another tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.care_relationship (tenant_id, patient_id, professional_id, assigned)
  VALUES (p_tenant, p_patient, p_professional, p_assigned)
  ON CONFLICT (tenant_id, patient_id, professional_id)
  DO UPDATE SET assigned = EXCLUDED.assigned, updated_at = now();
END
$$;
--> statement-breakpoint
-- Adds to (or takes from) the counters of qualifying appointments and encounters. The appointment
-- and encounter triggers of Stage 2 call it; the counters never go below zero.
CREATE FUNCTION app.care_adjust(p_tenant uuid, p_patient uuid, p_professional uuid, p_appointments integer, p_encounters integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'care relationship of another tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.care_relationship (tenant_id, patient_id, professional_id, qualifying_appointments, encounters)
  VALUES (p_tenant, p_patient, p_professional, greatest(p_appointments, 0), greatest(p_encounters, 0))
  ON CONFLICT (tenant_id, patient_id, professional_id)
  DO UPDATE SET
    qualifying_appointments = greatest(care_relationship.qualifying_appointments + p_appointments, 0),
    encounters = greatest(care_relationship.encounters + p_encounters, 0),
    updated_at = now();
END
$$;
--> statement-breakpoint
-- Default privileges of the schema give app_rw EXECUTE on every new function, so it is revoked
-- explicitly: only triggers (which run these as the owner) may call the maintenance functions.
REVOKE ALL ON FUNCTION app.care_set_assigned(uuid, uuid, uuid, boolean) FROM PUBLIC, app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.care_adjust(uuid, uuid, uuid, integer, integer) FROM PUBLIC, app_rw;
--> statement-breakpoint
-- Keeps care_relationship.assigned in step with the live assignments of the pair.
CREATE FUNCTION app.care_assignment_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app.care_set_assigned(
    NEW.tenant_id, NEW.patient_id, NEW.professional_id,
    EXISTS (
      SELECT 1 FROM public.care_assignment a
       WHERE a.tenant_id = NEW.tenant_id
         AND a.patient_id = NEW.patient_id
         AND a.professional_id = NEW.professional_id
         AND a.removed_at IS NULL
    )
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.care_assignment_sync() FROM PUBLIC, app_rw;
--> statement-breakpoint
CREATE TRIGGER care_assignment_sync
  AFTER INSERT OR UPDATE ON "care_assignment"
  FOR EACH ROW EXECUTE FUNCTION app.care_assignment_sync();
--> statement-breakpoint
-- Does the professional of this transaction treat this patient? Reads only the derived `active`
-- flag of care_relationship, so an appointment whose identity is not confirmed never counts.
CREATE FUNCTION app.is_treating(p_patient uuid, p_professional uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_relationship r
     WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
       AND r.patient_id = p_patient
       AND r.professional_id = p_professional
       AND r.active
  )
$$;
--> statement-breakpoint
-- The database backstop of the sharing-scope rule (design 4.2). Mirrors platform/authz/sharing-scope.ts:
--   readable = author || (visibility = 'default' && (treating || (not a prescription && sharing on
--              && the shared scope covers the entry)))
-- p_template_kind: the template name of a note; NULL for entries that follow the general ceiling
-- (anamnesis, documents, signed consent); 'prescription' for prescriptions, which never follow
-- sharing (D17). The sharing settings are read from the transaction settings that withTenant sets
-- for a professional; when they were not loaded, sharing is OFF. Anything unexpected is false.
CREATE FUNCTION app.clinical_readable(p_patient uuid, p_author uuid, p_visibility text, p_template_kind text)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
  sharing boolean := coalesce(nullif(current_setting('app.clinical_sharing', true), '')::boolean, false);
BEGIN
  IF me IS NULL THEN RETURN false; END IF;
  IF p_author = me THEN RETURN true; END IF;
  IF p_visibility IS DISTINCT FROM 'default' THEN RETURN false; END IF;
  IF app.is_treating(p_patient, me) THEN RETURN true; END IF;
  IF NOT sharing THEN RETURN false; END IF;
  IF p_template_kind = 'prescription' THEN RETURN false; END IF;
  IF p_template_kind IS NULL THEN RETURN true; END IF;
  RETURN p_template_kind = ANY (string_to_array(coalesce(current_setting('app.shared_templates', true), ''), ','));
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_treating(uuid, uuid) TO app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.clinical_readable(uuid, uuid, text, text) TO app_rw;
