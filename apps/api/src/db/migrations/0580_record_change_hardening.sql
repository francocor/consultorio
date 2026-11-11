-- Judgment day, Stage 5, round 3 (JD-S5 R3): the record changes of a patient and the guards around them.
--
-- R3-4  `registration_requires_invitation`: a change that gives an e-mail to a record that had none
--       (nobody was told, because there was nobody to tell), or whose previous address could not be
--       told, closes the PUBLIC registration of that patient (document number plus e-mail) until an
--       owner or an administrator invites the patient (`invitation_opened_at`). The seven days of
--       R2-2 do not cover it: whoever set the address could register once they were over.
-- R3-5  The columns of the notice sweep: a claim (`notice_claimed_at`), the attempts and the wait
--       between them, and `notice_expired_at` for a notice that could not be told.
-- R3-6  A transaction of the portal sees no row of the table and writes none. Rows are written only
--       by the trigger of `patient` (SECURITY DEFINER, hardened, no EXECUTE for anybody): the runtime
--       role has no INSERT. The guard of the update requires that an address leaves a row only when
--       the notice was told or expired.
-- B-W2  A later birth date never moves the review day of an existing representative link LATER
--       (LEAST of the old day and the new one): reception could extend the access of a representative
--       by correcting the birth date of a minor. If the earlier day suspends the link, restoring it
--       is `reverifyLink`, which is gated.
-- S5-1  The colleague who records the PDF of a prescription can only record the key of THAT
--       prescription (`t/<organization>/prescriptions/<id>.pdf`).
--
-- A correction to a note of 0596: its VALIDATE CONSTRAINT runs inside the single transaction of the
-- migrator, so on a database that applies 0591 and 0596 in one run it waits for the lock of the
-- ADD CONSTRAINT of 0591 until the run ends. It is harmless here (`prescription` is small where this
-- first runs, and Stage 5 is not deployed) and 0596 is not edited because it may be applied; the rule
-- of docs/migration-ranges.md is the one to follow from now on.
ALTER TABLE "patient_record_change" ADD COLUMN "notice_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD COLUMN "notice_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD COLUMN "notice_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD COLUMN "notice_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD COLUMN "registration_requires_invitation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD COLUMN "invitation_opened_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "patient_record_change_closed_idx" ON "patient_record_change" USING btree ("tenant_id","patient_id") WHERE "patient_record_change"."registration_requires_invitation" and "patient_record_change"."invitation_opened_at" is null;--> statement-breakpoint
ALTER TABLE "patient_record_change" ADD CONSTRAINT "patient_record_change_attempts_check" CHECK ("patient_record_change"."notice_attempts" >= 0) NOT VALID;
--> statement-breakpoint
-- R3-6: the portal never reads nor writes the table, and nothing but the trigger inserts into it.
CREATE POLICY "patient_record_change_no_portal" ON "patient_record_change" AS RESTRICTIVE
  USING (current_user = 'app_owner' OR coalesce(current_setting('app.actor_kind', true), '') <> 'portal')
  WITH CHECK (current_user = 'app_owner' OR coalesce(current_setting('app.actor_kind', true), '') <> 'portal');
--> statement-breakpoint
REVOKE INSERT ON "patient_record_change" FROM app_rw;
--> statement-breakpoint
-- R3-4 and R3-6: the trigger writes the row as the owner (the runtime role cannot), and flags the
-- change that gives an address to a record that had none.
CREATE OR REPLACE FUNCTION app.patient_record_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    before_email text := nullif(lower(btrim(coalesce(OLD.email::text, ''))), '');
    after_email text := nullif(lower(btrim(coalesce(NEW.email::text, ''))), '');
    email_moved boolean;
    birth_moved boolean := NEW.birth_date IS DISTINCT FROM OLD.birth_date;
  BEGIN
    email_moved := before_email IS DISTINCT FROM after_email;
    IF NOT (email_moved OR birth_moved) THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.patient_record_change
      (tenant_id, patient_id, email_changed, birth_date_changed, notice_email, registration_requires_invitation)
    VALUES (
      NEW.tenant_id, NEW.id, email_moved, birth_moved, before_email,
      -- Nobody to tell: the record had no address, so whoever sets one is watched by nobody.
      email_moved AND before_email IS NULL AND after_email IS NOT NULL
    );
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.patient_record_changed() FROM PUBLIC;
--> statement-breakpoint
COMMENT ON FUNCTION app.patient_record_changed() IS
  'Trigger of patient: writes patient_record_change as the owner (the runtime role has no INSERT on it). Nobody calls it.';
--> statement-breakpoint
-- What a row may become: it is told or it expires (the address is cleared with it), an owner or an
-- administrator opens the registration, and nothing else.
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
--> statement-breakpoint
-- B-W2: a later birth date does not extend the access of a representative.
CREATE OR REPLACE FUNCTION app.patient_birth_date_changed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    UPDATE public.portal_link
       SET majority_review_on = LEAST(majority_review_on, app.majority_review_date(NEW.birth_date, 18))
     WHERE tenant_id = NEW.tenant_id
       AND patient_id = NEW.id
       AND relationship = 'representative'
       AND status IN ('active', 'suspended')
       AND majority_review_on IS NOT NULL;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
COMMENT ON FUNCTION app.patient_birth_date_changed() IS
  'Argentina only: brings the review day of the representative links EARLIER with the age of majority of 18, never later (a later birth date does not extend the access of a representative; restoring a suspended link is a gated act). It runs as the user who corrects the birth date (SECURITY INVOKER). A second country pack must read the age from its pack.';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.prescription_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    by_system boolean := current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
      AND coalesce(current_setting('app.actor_kind', true), '') <> 'portal';
    only_document boolean;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF me IS NULL OR NEW.author_professional_id IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'a prescription is written by its own author' USING ERRCODE = '42501';
      END IF;
      IF NEW.status <> 'pending_submission' OR NEW.external_id IS NOT NULL OR NEW.issued_at IS NOT NULL THEN
        RAISE EXCEPTION 'a prescription starts waiting for the provider' USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END IF;

    -- The one write a colleague who can read the row may make: record where the PDF of an ISSUED
    -- prescription is, once, at the key of THIS prescription under the prefix of its own organization
    -- (JD-S5 R2-9, R3): a colleague cannot point the row at the PDF of another prescription. Nothing
    -- else changes, and a draft or a pending row has no document.
    only_document := OLD.document_key IS NULL AND NEW.document_key IS NOT NULL
      AND OLD.external_id IS NOT NULL
      AND NEW.document_key = 't/' || NEW.tenant_id::text || '/prescriptions/' || NEW.id::text || '.pdf'
      AND (to_jsonb(NEW) - 'document_key' - 'updated_at') = (to_jsonb(OLD) - 'document_key' - 'updated_at');
    IF me IS DISTINCT FROM OLD.author_professional_id AND NOT by_system
       AND current_user <> 'app_owner' AND NOT only_document THEN
      RAISE EXCEPTION 'only the prescriber changes a prescription' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.author_professional_id IS DISTINCT FROM OLD.author_professional_id
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.client_key IS DISTINCT FROM OLD.client_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      RAISE EXCEPTION 'the identity of a prescription never changes' USING ERRCODE = '23000';
    END IF;

    -- The key the provider is asked with moves only when a refused draft is corrected and sent again.
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.submission_version IS DISTINCT FROM OLD.submission_version THEN
      IF NOT (
        OLD.status = 'draft' AND NEW.status = 'pending_submission'
        AND NEW.submission_version = OLD.submission_version + 1
        AND NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      ) THEN
        RAISE EXCEPTION 'the provider key of a prescription changes only when a refused draft is sent again' USING ERRCODE = '23000';
      END IF;
    END IF;

    -- That the provider may have been asked is never forgotten.
    IF OLD.provider_contacted_at IS NOT NULL
       AND NEW.provider_contacted_at IS DISTINCT FROM OLD.provider_contacted_at THEN
      RAISE EXCEPTION 'a prescription the provider may hold stays marked' USING ERRCODE = '23000';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('pending_submission', 'cancelled'))
      OR (OLD.status = 'pending_submission' AND NEW.status IN ('issued', 'draft', 'cancelled'))
      OR (OLD.status = 'issued' AND NEW.status IN ('cancelled', 'dispensed', 'expired'))
    ) THEN
      RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '23000';
    END IF;

    IF OLD.status <> 'draft' AND (
         NEW.content_enc IS DISTINCT FROM OLD.content_enc
      OR NEW.prescription_date IS DISTINCT FROM OLD.prescription_date
    ) THEN
      RAISE EXCEPTION 'the content of a prescription changes only while it is a refused draft' USING ERRCODE = '23000';
    END IF;

    IF OLD.status IN ('issued', 'dispensed', 'expired', 'cancelled') AND OLD.external_id IS NOT NULL AND (
         NEW.external_id IS DISTINCT FROM OLD.external_id
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
      OR NEW.registered_manually IS DISTINCT FROM OLD.registered_manually
      OR NEW.simulated IS DISTINCT FROM OLD.simulated
    ) THEN
      RAISE EXCEPTION 'an issued prescription never changes' USING ERRCODE = '23000';
    END IF;
    IF OLD.status = 'cancelled' AND (
         NEW.cancel_reason_enc IS DISTINCT FROM OLD.cancel_reason_enc
      OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    ) THEN
      RAISE EXCEPTION 'a cancelled prescription keeps its reason' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
