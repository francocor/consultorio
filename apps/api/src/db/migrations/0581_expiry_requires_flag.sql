-- Judgment day, Stage 5, round 4 (JD-S5 R4-6): the guard of `patient_record_change` refuses to give a
-- notice up (`notice_expired_at`) unless `registration_requires_invitation` is true in the same write.
-- The sweep always did both together; this makes the database say it, so no other writer can expire
-- a notice and leave the registration of the patient open. The rest of the guard is the one of 0580.
CREATE OR REPLACE FUNCTION app.patient_record_change_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.email_changed IS DISTINCT FROM OLD.email_changed
       OR NEW.birth_date_changed IS DISTINCT FROM OLD.birth_date_changed
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a change to the record of a patient is not edited' USING ERRCODE = '23000';
    END IF;
    IF NEW.notice_email IS NOT NULL AND NEW.notice_email IS DISTINCT FROM OLD.notice_email THEN
      RAISE EXCEPTION 'the address of a notice is never replaced' USING ERRCODE = '23000';
    END IF;
    -- An address leaves the row only when it was told or the notice expired: nothing else clears it.
    IF OLD.notice_email IS NOT NULL AND NEW.notice_email IS NULL
       AND NEW.notice_sent_at IS NULL AND NEW.notice_expired_at IS NULL THEN
      RAISE EXCEPTION 'the address of a notice is cleared only when it was told or it expired' USING ERRCODE = '23000';
    END IF;
    -- A notice that expires closes the registration of the patient, in the same write (JD-S5 R4-6):
    -- the previous address counts as never told, so only an invitation may open it again.
    IF NEW.notice_expired_at IS NOT NULL AND OLD.notice_expired_at IS NULL
       AND NOT NEW.registration_requires_invitation THEN
      RAISE EXCEPTION 'a notice expires only with the registration of the patient closed' USING ERRCODE = '23000';
    END IF;
    IF NEW.notice_sent_at IS NOT NULL AND NEW.notice_expired_at IS NOT NULL THEN
      RAISE EXCEPTION 'a notice was told or it expired, not both' USING ERRCODE = '23000';
    END IF;
    IF (OLD.notice_sent_at IS NOT NULL AND NEW.notice_sent_at IS DISTINCT FROM OLD.notice_sent_at)
       OR (OLD.notice_expired_at IS NOT NULL AND NEW.notice_expired_at IS DISTINCT FROM OLD.notice_expired_at)
       OR (OLD.invitation_opened_at IS NOT NULL AND NEW.invitation_opened_at IS DISTINCT FROM OLD.invitation_opened_at) THEN
      RAISE EXCEPTION 'what happened to a change is written once' USING ERRCODE = '23000';
    END IF;
    -- The registration is closed by the trigger or by the expiry of a notice, and opened by an
    -- invitation (`invitation_opened_at`); the flag itself is never lowered.
    IF OLD.registration_requires_invitation AND NOT NEW.registration_requires_invitation THEN
      RAISE EXCEPTION 'the registration of a patient is opened by an invitation, not by clearing the flag' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
