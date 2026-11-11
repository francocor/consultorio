ALTER TABLE "addendum" DROP CONSTRAINT "addendum_reason_check";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP CONSTRAINT "clinical_note_state_check";--> statement-breakpoint
ALTER TABLE "addendum" DROP COLUMN "reason";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP COLUMN "error_reason";
--> statement-breakpoint
CREATE TABLE "clinical_footprint" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	CONSTRAINT "clinical_footprint_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "clinical_footprint_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "clinical_footprint_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "addendum" ADD COLUMN "reason_enc" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "error_reason_enc" "bytea";--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_footprint_patient_key" ON "clinical_footprint" USING btree ("tenant_id","patient_id");--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_state_check" CHECK ((
        ("clinical_note"."status" = 'draft'
          and "clinical_note"."signed_at" is null
          and "clinical_note"."error_reason_enc" is null and "clinical_note"."error_marked_by" is null
          and "clinical_note"."error_marked_at" is null)
        or ("clinical_note"."status" = 'signed'
          and "clinical_note"."signed_at" is not null
          and "clinical_note"."draft_content_enc" is null
          and "clinical_note"."error_reason_enc" is null and "clinical_note"."error_marked_by" is null
          and "clinical_note"."error_marked_at" is null)
        or ("clinical_note"."status" = 'entered_in_error'
          and "clinical_note"."error_reason_enc" is not null
          and "clinical_note"."error_marked_by" is not null and "clinical_note"."error_marked_at" is not null
          and "clinical_note"."draft_content_enc" is null)
      ));
--> statement-breakpoint
ALTER TABLE "clinical_footprint" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_footprint" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinical_footprint" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- Decision D20: opening an encounter no longer creates the care relationship by itself. Only a SIGNED
-- encounter counts, and an encounter is opened only on a patient the professional treats, or on a
-- patient nobody has written about yet.
DROP TRIGGER encounter_care_sync ON "encounter";
--> statement-breakpoint
DROP FUNCTION app.encounter_care_sync();
--> statement-breakpoint

-- Somebody has written about this patient. Holds no clinical content; every professional of the
-- tenant reads it (it only answers "has this record been started?") and only the triggers below
-- write it, as the owner, because the clinical tables are hidden from a definer function by the
-- professional policies.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "clinical_footprint" FROM app_rw;
--> statement-breakpoint
CREATE FUNCTION app.clinical_footprint_mark() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    INSERT INTO public.clinical_footprint (tenant_id, patient_id)
    VALUES (NEW.tenant_id, NEW.patient_id)
    ON CONFLICT (tenant_id, patient_id) DO NOTHING;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.clinical_footprint_mark() FROM PUBLIC, app_rw;
--> statement-breakpoint
CREATE TRIGGER clinical_note_footprint AFTER INSERT ON "clinical_note"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_footprint_mark();
--> statement-breakpoint
CREATE TRIGGER anamnesis_footprint AFTER INSERT ON "anamnesis"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_footprint_mark();
--> statement-breakpoint

-- Does this patient have any clinical footprint or any active care relationship, with anybody?
-- An invoker function: it reads only the two tables above, both open to the tenant.
CREATE FUNCTION app.has_clinical_footprint(p_patient uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clinical_footprint f
     WHERE f.tenant_id = current_setting('app.tenant_id')::uuid AND f.patient_id = p_patient
  ) OR EXISTS (
    SELECT 1 FROM public.care_relationship r
     WHERE r.tenant_id = current_setting('app.tenant_id')::uuid AND r.patient_id = p_patient AND r.active
  )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.has_clinical_footprint(uuid) TO app_rw;
--> statement-breakpoint

-- Existing rows: the footprint of every patient that already has a note or an anamnesis, and the
-- care relationship recounted from SIGNED entries only. A migration has no tenant context, so row
-- level security is lifted on these tables for the length of this transaction.
ALTER TABLE "clinical_note" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "anamnesis" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_footprint" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "care_relationship" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "clinical_footprint" (tenant_id, patient_id)
  SELECT tenant_id, patient_id FROM "clinical_note"
  UNION
  SELECT tenant_id, patient_id FROM "anamnesis"
ON CONFLICT (tenant_id, patient_id) DO NOTHING;
--> statement-breakpoint
UPDATE "care_relationship" r
   SET encounters = (
     SELECT count(*) FROM "clinical_note" n
      WHERE n.tenant_id = r.tenant_id AND n.patient_id = r.patient_id
        AND n.author_professional_id = r.professional_id AND n.status = 'signed'
   )
 WHERE r.encounters > 0;
--> statement-breakpoint
ALTER TABLE "care_relationship" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_footprint" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "anamnesis" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The encounter: besides being opened by its own author, the author needs a care relationship with
-- the patient unless nobody has written about the patient yet. The footprint of the first note does
-- not exist yet when this runs (the note is inserted after the encounter).
CREATE OR REPLACE FUNCTION app.encounter_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF me IS NULL OR NEW.author_professional_id IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'an encounter is opened by its own author' USING ERRCODE = '42501';
      END IF;
      IF NOT app.is_treating(NEW.patient_id, me) AND app.has_clinical_footprint(NEW.patient_id) THEN
        RAISE EXCEPTION 'opening an encounter needs a care relationship with the patient' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'visibility' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'visibility' - 'updated_at') THEN
      RAISE EXCEPTION 'an encounter cannot change' USING ERRCODE = '23000';
    END IF;
    IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      IF me IS DISTINCT FROM OLD.author_professional_id THEN
        RAISE EXCEPTION 'only the author restricts an entry' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.clinical_note n
         WHERE n.tenant_id = OLD.tenant_id AND n.encounter_id = OLD.id AND n.status <> 'draft'
      ) THEN
        RAISE EXCEPTION 'the visibility of an entry is fixed once it is signed' USING ERRCODE = '23000';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint

-- The note guard changes in two places: the error columns are now encrypted (error_reason_enc), and
-- marking an entry in error drops the working copy of a draft (M1), so it cannot stay readable.
CREATE OR REPLACE FUNCTION app.clinical_note_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    parent public.encounter%ROWTYPE;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      SELECT * INTO parent FROM public.encounter e
       WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.encounter_id;
      IF NOT FOUND
         OR parent.patient_id <> NEW.patient_id
         OR parent.author_professional_id <> NEW.author_professional_id
         OR parent.template_kind <> NEW.template_kind
         OR parent.visibility <> NEW.visibility THEN
        RAISE EXCEPTION 'a note must match its encounter' USING ERRCODE = '23503';
      END IF;
      IF me IS NULL OR NEW.author_professional_id <> me THEN
        RAISE EXCEPTION 'a note is written by its own author' USING ERRCODE = '42501';
      END IF;
      IF NEW.status <> 'draft' OR NEW.draft_revision <> 0 THEN
        RAISE EXCEPTION 'a note starts as an empty draft' USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status = 'entered_in_error' THEN
      RAISE EXCEPTION 'an entry marked in error cannot change' USING ERRCODE = '23000';
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.encounter_id <> OLD.encounter_id
       OR NEW.patient_id <> OLD.patient_id OR NEW.author_professional_id <> OLD.author_professional_id
       OR NEW.template_kind <> OLD.template_kind OR NEW.template_version <> OLD.template_version
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'who, what and for whom an entry is never changes' USING ERRCODE = '23000';
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
      IF me IS DISTINCT FROM OLD.author_professional_id THEN
        RAISE EXCEPTION 'only the author edits a draft' USING ERRCODE = '42501';
      END IF;
      IF NEW.draft_revision <> OLD.draft_revision + 1 THEN
        RAISE EXCEPTION 'a draft moves forward one revision at a time' USING ERRCODE = '23000';
      END IF;
      IF (to_jsonb(NEW) - 'draft_content_enc' - 'draft_revision' - 'visibility' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'draft_content_enc' - 'draft_revision' - 'visibility' - 'updated_at') THEN
        RAISE EXCEPTION 'a draft changes its content and visibility only' USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'signed' THEN
      IF me IS DISTINCT FROM OLD.author_professional_id THEN
        RAISE EXCEPTION 'only the author signs' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.note_version v
         WHERE v.tenant_id = OLD.tenant_id AND v.note_id = OLD.id AND v.version_no = 1
      ) THEN
        RAISE EXCEPTION 'an entry is signed together with its signed version' USING ERRCODE = '23000';
      END IF;
      IF (to_jsonb(NEW) - 'status' - 'signed_at' - 'draft_content_enc' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'signed_at' - 'draft_content_enc' - 'updated_at') THEN
        RAISE EXCEPTION 'signing changes nothing but the status' USING ERRCODE = '23000';
      END IF;
      NEW.signed_at := now();
      RETURN NEW;
    END IF;

    IF NEW.status = 'entered_in_error' THEN
      -- A draft is marked by its author only; a signed entry by its author or by another
      -- treating professional (never by somebody who reads it only through sharing).
      IF OLD.status = 'draft' AND me IS DISTINCT FROM OLD.author_professional_id THEN
        RAISE EXCEPTION 'only the author marks a draft' USING ERRCODE = '42501';
      END IF;
      IF OLD.status = 'signed'
         AND (me IS NULL OR NOT (me = OLD.author_professional_id OR app.is_treating(OLD.patient_id, me))) THEN
        RAISE EXCEPTION 'only the author or a treating professional marks an entry' USING ERRCODE = '42501';
      END IF;
      -- A draft has nothing worth keeping once it is known to be in error: its working copy goes.
      IF NEW.draft_content_enc IS NOT NULL THEN
        RAISE EXCEPTION 'an entry marked in error drops its working copy' USING ERRCODE = '23000';
      END IF;
      IF (to_jsonb(NEW) - 'status' - 'draft_content_enc' - 'error_reason_enc' - 'error_marked_by' - 'error_marked_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'draft_content_enc' - 'error_reason_enc' - 'error_marked_by' - 'error_marked_at' - 'updated_at') THEN
        RAISE EXCEPTION 'marking an entry in error keeps its content' USING ERRCODE = '23000';
      END IF;
      NEW.error_marked_by := me;
      NEW.error_marked_at := now();
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'a signed entry cannot be changed' USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint

-- The care relationship counts SIGNED encounters. Signing one adds it; marking a signed one in error
-- takes it away again (otherwise opening an encounter on the wrong patient would leave the
-- professional with access to that patient whole record). A draft marked in error never counted.
CREATE OR REPLACE FUNCTION app.clinical_note_care_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF OLD.status = 'draft' AND NEW.status = 'signed' THEN
      PERFORM app.care_adjust(NEW.tenant_id, NEW.patient_id, NEW.author_professional_id, 0, 1);
    ELSIF OLD.status = 'signed' AND NEW.status = 'entered_in_error' THEN
      PERFORM app.care_adjust(NEW.tenant_id, NEW.patient_id, NEW.author_professional_id, 0, -1);
    END IF;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
DROP TRIGGER clinical_note_care_sync ON "clinical_note";
--> statement-breakpoint
CREATE TRIGGER clinical_note_care_sync AFTER UPDATE OF status ON "clinical_note"
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.clinical_note_care_sync();
