-- The appointment source of the care relationship (design 3.6, decisions D2, D14, D15).
--
-- "This professional treats this patient" is a fact, and it is derived, never written by hand: an
-- appointment with the professional counts when its status is scheduled, confirmed, checked_in,
-- in_progress, attended or no_show AND its identity is confirmed. A pending_approval appointment
-- never counts, a cancelled one never counts, and an appointment whose identity is not confirmed
-- never counts, so access before the identity is confirmed is impossible by construction: row level
-- security (`app.clinical_readable`) reads only the `active` flag of this table.
--
-- The encounter source arrives with the clinical schema (task 2.52); the assignment source exists
-- since Stage 1. Each source keeps its own counter and `active` is "any source above zero".

-- Counts the qualifying appointments of one pair and brings the counter to that number. A lock per
-- pair serializes concurrent changes, and the count is taken after the lock, so two transactions
-- that touch the same pair cannot leave a stale counter behind.
CREATE FUNCTION app.recompute_care_relationship(p_tenant uuid, p_patient uuid, p_professional uuid)
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
  PERFORM pg_advisory_xact_lock(hashtextextended('care:' || p_tenant::text || p_patient::text || p_professional::text, 0));

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
-- After any change that can alter whether an appointment counts, or for whom: the old pair and the
-- new pair are both recomputed (a reassignment or a rejected match moves the relationship).
CREATE FUNCTION app.appointment_care_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD.patient_id IS DISTINCT FROM NEW.patient_id OR OLD.professional_id IS DISTINCT FROM NEW.professional_id) THEN
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
--> statement-breakpoint
CREATE TRIGGER appointment_care_sync
  AFTER INSERT OR UPDATE OF status, identity_confirmed, patient_id, professional_id ON "appointment"
  FOR EACH ROW EXECUTE FUNCTION app.appointment_care_sync();
