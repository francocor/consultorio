-- Stage 2 scheduling review, finding 13: a reassignment recomputes two care relationships, and
-- their advisory locks must always be taken in the same order.
--
-- `appointment_care_sync` recomputed the OLD pair and then the NEW pair, each behind the advisory
-- lock of its pair. Two opposite moves (patient P from professional A to B, and from B to A) could
-- each hold one lock and wait for the other: a deadlock that depended on the data. Both locks are
-- now taken first, in the order of their keys, whichever pair is the old one; the recomputation
-- then finds them already held (an advisory lock can be taken again by its own transaction).

-- The advisory lock key of the care relationship of one pair. One definition, so the function that
-- recomputes and the trigger that orders the locks cannot disagree.
CREATE FUNCTION app.care_lock_key(p_tenant uuid, p_patient uuid, p_professional uuid)
RETURNS bigint
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT hashtextextended('care:' || p_tenant::text || p_patient::text || p_professional::text, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.care_lock_key(uuid, uuid, uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recompute_care_relationship(p_tenant uuid, p_patient uuid, p_professional uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  wanted integer;
  have integer;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'care relationship of another tenant' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(app.care_lock_key(p_tenant, p_patient, p_professional));

  SELECT count(*)::integer INTO wanted
    FROM public.appointment a
   WHERE a.tenant_id = p_tenant
     AND a.patient_id = p_patient
     AND a.professional_id = p_professional
     AND a.identity_confirmed
     AND a.status IN ('scheduled', 'confirmed', 'checked_in', 'in_progress', 'attended', 'no_show');

  SELECT coalesce(max(r.qualifying_appointments), 0) INTO have
    FROM public.care_relationship r
   WHERE r.tenant_id = p_tenant AND r.patient_id = p_patient AND r.professional_id = p_professional;

  IF wanted <> have THEN
    PERFORM app.care_adjust(p_tenant, p_patient, p_professional, wanted - have, 0);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.appointment_care_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_key bigint;
  new_key bigint;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD.patient_id IS DISTINCT FROM NEW.patient_id OR OLD.professional_id IS DISTINCT FROM NEW.professional_id) THEN
    old_key := app.care_lock_key(OLD.tenant_id, OLD.patient_id, OLD.professional_id);
    new_key := app.care_lock_key(NEW.tenant_id, NEW.patient_id, NEW.professional_id);
    -- Lowest key first, whichever pair is the old one.
    PERFORM pg_advisory_xact_lock(least(old_key, new_key));
    PERFORM pg_advisory_xact_lock(greatest(old_key, new_key));
    PERFORM app.recompute_care_relationship(OLD.tenant_id, OLD.patient_id, OLD.professional_id);
  END IF;
  PERFORM app.recompute_care_relationship(NEW.tenant_id, NEW.patient_id, NEW.professional_id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.recompute_care_relationship(uuid, uuid, uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.appointment_care_sync() FROM PUBLIC, app_rw;
