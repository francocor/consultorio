-- Immutability and care-relationship triggers of the clinical tables (clinical-records, "Draft,
-- signing and immutability", "Addenda and corrections"; authorization AUZ-11).
--
-- The rules live in the database, not only in the services, because a signed entry must be
-- immutable "by any role, via any path". The triggers also stop the migration owner. The one
-- exception is the privileged reset of a DEMO organization (app.demo_reset), which empties the
-- tables of a fictitious tenant; it is recognised exactly as the audit trail recognises it.
--
-- Error codes, so tests and callers can tell the families apart:
--   23000  the rule "this never changes" (immutability, wrong state)
--   23503  a row that does not match its parent (missing, hidden by row level security, or a
--          repeated column that differs); the same code the composite foreign keys use
--   42501  the wrong actor (not the author, not treating)

-- Deletes: never, except the demo reset.
CREATE FUNCTION app.clinical_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF current_user = 'app_owner'
       AND current_setting('app.demo_reset', true) = OLD.tenant_id::text
       AND EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = OLD.tenant_id AND t.is_demo) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint
CREATE FUNCTION app.clinical_no_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    RAISE EXCEPTION '% is never emptied', TG_TABLE_NAME USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER encounter_no_delete BEFORE DELETE ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER clinical_note_no_delete BEFORE DELETE ON "clinical_note"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER note_version_no_delete BEFORE DELETE ON "note_version"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER addendum_no_delete BEFORE DELETE ON "addendum"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER encounter_no_truncate BEFORE TRUNCATE ON "encounter"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER clinical_note_no_truncate BEFORE TRUNCATE ON "clinical_note"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER note_version_no_truncate BEFORE TRUNCATE ON "note_version"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER addendum_no_truncate BEFORE TRUNCATE ON "addendum"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint

-- Encounter: written by its own author; afterwards only its visibility can change, and only while
-- the note is a draft (the note's trigger below keeps the two equal).
CREATE FUNCTION app.encounter_guard() RETURNS trigger
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
CREATE TRIGGER encounter_guard BEFORE INSERT OR UPDATE ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION app.encounter_guard();
--> statement-breakpoint

-- Source 2 of the care relationship (design 3.6): an encounter by the professional. The runtime
-- role cannot write care_relationship, so this runs as the owner. It counts the encounter at once,
-- draft included, because opening one is already a care act.
CREATE FUNCTION app.encounter_care_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM app.care_adjust(NEW.tenant_id, NEW.patient_id, NEW.author_professional_id, 0, 1);
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.encounter_care_sync() FROM PUBLIC, app_rw;
--> statement-breakpoint
CREATE TRIGGER encounter_care_sync AFTER INSERT ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION app.encounter_care_sync();
--> statement-breakpoint

-- The note: draft -> signed -> entered_in_error, and draft -> entered_in_error (a draft opened on
-- the wrong patient). Nothing else, and nothing from entered_in_error.
CREATE FUNCTION app.clinical_note_guard() RETURNS trigger
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
      IF (to_jsonb(NEW) - 'status' - 'error_reason' - 'error_marked_by' - 'error_marked_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'error_reason' - 'error_marked_by' - 'error_marked_at' - 'updated_at') THEN
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
CREATE TRIGGER clinical_note_guard BEFORE INSERT OR UPDATE ON "clinical_note"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_note_guard();
--> statement-breakpoint

-- Keeps the encounter's visibility equal to the note's while the note is a draft.
CREATE FUNCTION app.clinical_note_sync_encounter() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    UPDATE public.encounter
       SET visibility = NEW.visibility
     WHERE tenant_id = NEW.tenant_id AND id = NEW.encounter_id
       AND visibility IS DISTINCT FROM NEW.visibility;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER clinical_note_sync_encounter AFTER UPDATE OF visibility ON "clinical_note"
  FOR EACH ROW WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility)
  EXECUTE FUNCTION app.clinical_note_sync_encounter();
--> statement-breakpoint

-- An entry marked in error is not an encounter that happened: it stops counting towards the care
-- relationship. Otherwise opening an encounter on the wrong patient would leave the professional
-- with access to that patient's whole record. Runs as the owner (care_relationship is closed to
-- the runtime role).
CREATE FUNCTION app.clinical_note_care_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM app.care_adjust(NEW.tenant_id, NEW.patient_id, NEW.author_professional_id, 0, -1);
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.clinical_note_care_sync() FROM PUBLIC, app_rw;
--> statement-breakpoint
CREATE TRIGGER clinical_note_care_sync AFTER UPDATE OF status ON "clinical_note"
  FOR EACH ROW WHEN (NEW.status = 'entered_in_error' AND OLD.status <> 'entered_in_error')
  EXECUTE FUNCTION app.clinical_note_care_sync();
--> statement-breakpoint

-- The signed version: written once, for a draft, by its author, repeating the note's own columns.
CREATE FUNCTION app.note_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    parent public.clinical_note%ROWTYPE;
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'a signed version never changes' USING ERRCODE = '23000';
    END IF;
    SELECT * INTO parent FROM public.clinical_note n
     WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.note_id;
    IF NOT FOUND
       OR parent.patient_id <> NEW.patient_id
       OR parent.author_professional_id <> NEW.author_professional_id
       OR parent.template_kind <> NEW.template_kind
       OR parent.template_version <> NEW.template_version
       OR parent.visibility <> NEW.visibility THEN
      RAISE EXCEPTION 'a version must match its note' USING ERRCODE = '23503';
    END IF;
    IF me IS NULL OR NEW.author_professional_id <> me THEN
      RAISE EXCEPTION 'only the author signs' USING ERRCODE = '42501';
    END IF;
    IF parent.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft is signed' USING ERRCODE = '23000';
    END IF;
    IF NEW.version_no <> 1 THEN
      RAISE EXCEPTION 'an entry has one signed version' USING ERRCODE = '23000';
    END IF;
    NEW.signed_at := now();
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER note_version_guard BEFORE INSERT OR UPDATE ON "note_version"
  FOR EACH ROW EXECUTE FUNCTION app.note_version_guard();
--> statement-breakpoint

-- The addendum: written once, on a signed entry, by a professional acting as its author,
-- repeating the note's visibility and template (the policy "addendum_treating_only" of migration
-- 0060 adds that the author must be a TREATING professional).
CREATE FUNCTION app.addendum_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    parent public.clinical_note%ROWTYPE;
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'an addendum never changes' USING ERRCODE = '23000';
    END IF;
    SELECT * INTO parent FROM public.clinical_note n
     WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.note_id;
    IF NOT FOUND
       OR parent.patient_id <> NEW.patient_id
       OR parent.template_kind <> NEW.template_kind
       OR parent.visibility <> NEW.visibility THEN
      RAISE EXCEPTION 'an addendum must match its note' USING ERRCODE = '23503';
    END IF;
    IF me IS NULL OR NEW.author_professional_id <> me THEN
      RAISE EXCEPTION 'an addendum is written by its own author' USING ERRCODE = '42501';
    END IF;
    IF parent.status <> 'signed' THEN
      RAISE EXCEPTION 'an addendum goes on a signed entry' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER addendum_guard BEFORE INSERT OR UPDATE ON "addendum"
  FOR EACH ROW EXECUTE FUNCTION app.addendum_guard();
