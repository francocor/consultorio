-- Judgment day, Stage 5, round 2 (JD-S5 R2): the prescription table after the second review.
--
-- R2-3  `provider_in_flight_until`: a call to the provider that timed out may still be running there.
--       Until this day nothing is sent again, cancelled or registered by hand.
-- R2-7  `attempt_lease_token`: the lease of an attempt is released only by the attempt that took it.
-- R2-9  The one write a colleague may make on a row they only read (the place of the PDF) needs an
--       issued prescription and the prefix of the organization.
-- R2-11 The check of 0591 was left NOT VALID; it is validated here (the lock of VALIDATE lets reads
--       and writes go on).
ALTER TABLE "prescription" ADD COLUMN "attempt_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "provider_in_flight_until" timestamp with time zone;
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
    -- prescription is, once, under the prefix of its own organization (JD-S5 R2-9). Nothing else
    -- changes, and a draft or a pending row has no document.
    only_document := OLD.document_key IS NULL AND NEW.document_key IS NOT NULL
      AND OLD.external_id IS NOT NULL
      AND NEW.document_key LIKE 't/' || NEW.tenant_id::text || '/prescriptions/%'
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
--> statement-breakpoint
ALTER TABLE "prescription" VALIDATE CONSTRAINT "prescription_submission_version_check";
