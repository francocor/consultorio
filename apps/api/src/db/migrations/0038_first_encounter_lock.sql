-- Judgment Day, Stage 2, round 1, finding C8: the first-encounter exception is serialized.
--
-- An encounter needs a care relationship, except on a patient nobody has written about yet (D20).
-- The footprint check and the footprint itself (marked when the first note is inserted) were not
-- ordered, so two professionals opening the first encounter of the same patient at the same time
-- both found no footprint and both got in. The check now runs behind a transaction-level advisory
-- lock keyed by (organization, patient), held until the first one commits its footprint: the second
-- one waits, then sees it and is refused. A professional who already treats the patient never
-- needs the exception and never takes the lock.
CREATE FUNCTION app.lock_first_encounter(p_patient uuid)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('first_encounter:' || current_setting('app.tenant_id')::text || p_patient::text, 0))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_first_encounter(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_first_encounter(uuid) TO app_rw;
--> statement-breakpoint
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
      IF NOT app.is_treating(NEW.patient_id, me) THEN
        -- The one exception is the first encounter of the patient, so two of them must not both pass.
        PERFORM app.lock_first_encounter(NEW.patient_id);
        IF app.has_clinical_footprint(NEW.patient_id) THEN
          RAISE EXCEPTION 'opening an encounter needs a care relationship with the patient' USING ERRCODE = '42501';
        END IF;
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
