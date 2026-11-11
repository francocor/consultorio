-- Integration of the clinical record with the agenda and the documents (decision D20).
--
-- 1. An encounter that names an appointment points at it by the composite key, so it cannot name
--    an appointment of another organization or one that does not exist.
-- 2. A document that belongs to an encounter points at it the same way.
-- 3. The encounter guard also checks WHAT the appointment is: the same patient, the author as its
--    professional, a confirmed identity (D14, D18) and a status that counts for the care
--    relationship. An unconfirmed appointment never opens a clinical record.
--
-- The check of the existing rows when a foreign key is added runs as the table owner, and FORCE ROW
-- LEVEL SECURITY binds the owner on every table involved: their tenant policy would read an
-- `app.tenant_id` nobody set (22P02). Row level security is lifted for the length of these
-- statements, inside the migration's transaction, and put back at once (see migration 0030).
ALTER TABLE "document" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "encounter" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_encounter_fkey" FOREIGN KEY ("tenant_id","encounter_id") REFERENCES "public"."encounter"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The encounter guard (0033) plus the appointment rule. It runs as the invoking professional, so it
-- reads the appointment through the same row level security as everything else: an appointment the
-- professional cannot see is an appointment that does not exist.
CREATE OR REPLACE FUNCTION app.encounter_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    appt record;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF me IS NULL OR NEW.author_professional_id IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'an encounter is opened by its own author' USING ERRCODE = '42501';
      END IF;
      IF NEW.appointment_id IS NOT NULL THEN
        SELECT a.patient_id, a.professional_id, a.identity_confirmed, a.status INTO appt
          FROM public.appointment a
         WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id;
        -- Like the note guard, a parent that does not match is reported as a foreign key violation.
        IF NOT FOUND OR appt.patient_id <> NEW.patient_id OR appt.professional_id <> NEW.author_professional_id THEN
          RAISE EXCEPTION 'an encounter names an appointment of its own patient and author' USING ERRCODE = '23503';
        END IF;
        IF NOT appt.identity_confirmed
           OR appt.status NOT IN ('scheduled', 'confirmed', 'checked_in', 'in_progress', 'attended', 'no_show') THEN
          RAISE EXCEPTION 'an appointment without a confirmed identity (or cancelled) is not a care source' USING ERRCODE = '42501';
        END IF;
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
