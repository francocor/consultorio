-- Judgment day, Stage 5, round 1 (JD-S5 R1): the prescription table after the first adversarial review.
--
-- S5-3  `provider_contacted_at` (set before the provider is asked, never cleared) and
--       `attempt_lease_until` (the row is owned by an attempt that holds no connection).
-- S5-4  `submission_version`: the key the provider is asked with is derived from it, so a refused
--       prescription that was corrected is sent under a NEW key.
-- S5-2  The portal runs as the nil user (the patient has no user), so the clinical policies of this
--       table, which let the system through, would have let the portal through. The portal marks its
--       transactions with `app.actor_kind = 'portal'` and the policies and the guard stop treating
--       such a transaction as the system. The portal reads prescriptions only through two
--       SELECT-only definer functions bound to the link and the identity of its session.
ALTER TABLE "prescription" ADD COLUMN "submission_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "provider_contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "attempt_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_submission_version_check" CHECK ("prescription"."submission_version" >= 1) NOT VALID;
--> statement-breakpoint
-- A row that may have reached the provider before the new column existed is not marked, and its
-- `last_attempt_at` is what has always told that an attempt was made, so nothing is backfilled here.

-- S5-2: the system the clinical policies let through is a worker or a job, never the portal.
ALTER POLICY "clinical_professionals_only" ON "prescription" USING (
  nullif(current_setting('app.professional_id', true), '') IS NOT NULL
  OR (
    current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
    AND coalesce(current_setting('app.actor_kind', true), '') <> 'portal'
  )
  OR current_user = 'app_owner'
);
--> statement-breakpoint
ALTER POLICY "clinical_scope" ON "prescription" USING (
  (
    current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
    AND coalesce(current_setting('app.actor_kind', true), '') <> 'portal'
  )
  OR current_user = 'app_owner'
  OR app.clinical_readable("patient_id", "author_professional_id", "visibility", 'prescription'::text)
);
--> statement-breakpoint
-- The rules of 0530 with three changes: a portal transaction is not the system; the PDF of a
-- prescription is recorded once by whoever can read the row (a colleague who treats the patient
-- asks for the document and no longer needs a second connection to write it); and the provider key
-- changes only when a refused draft is sent again, with the submission version going up by one.
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

    only_document := OLD.document_key IS NULL AND NEW.document_key IS NOT NULL
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
-- The day it is in the organization (JD-S5 R1-S5-7). The portal binds the day it computed from the
-- clock of the application (`app.portal_today`) next to the link and the identity of the session;
-- without it the day is the one of Buenos Aires, the only country pack there is.
CREATE FUNCTION app.portal_today() RETURNS date
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(
      nullif(current_setting('app.portal_today', true), '')::date,
      (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_today() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_today() TO app_rw;
--> statement-breakpoint
-- The prescriptions of the patient of the link of this request: the identifier, the day, where it
-- stands and where its PDF is, never a medication, and only those the provider confirmed. It answers
-- for the link and the identity the request validated (`app.portal_link_id` and
-- `app.portal_identity_id`, bound by `withPortalSubject`) and re-checks them here against the tables:
-- the link must be live, belong to that identity and the identity must be active, and a link past the
-- majority of its patient reads nothing. A forged setting alone opens nothing that is not a live link.
CREATE FUNCTION app.portal_prescriptions()
RETURNS TABLE (
  id uuid,
  patient_id uuid,
  issued_at timestamp with time zone,
  status text,
  document_key text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id, p.patient_id, p.issued_at, p.status, p.document_key
    FROM public.portal_link l
    JOIN public.portal_identity i
      ON i.tenant_id = l.tenant_id AND i.id = l.portal_identity_id AND i.status = 'active'
    JOIN public.prescription p
      ON p.tenant_id = l.tenant_id AND p.patient_id = l.patient_id
   WHERE l.tenant_id = current_setting('app.tenant_id')::uuid
     AND l.id = nullif(current_setting('app.portal_link_id', true), '')::uuid
     AND l.portal_identity_id = nullif(current_setting('app.portal_identity_id', true), '')::uuid
     AND l.status = 'active'
     AND (l.majority_review_on IS NULL OR l.majority_review_on > app.portal_today())
     AND p.status IN ('issued', 'cancelled', 'dispensed', 'expired')
     AND p.issued_at IS NOT NULL
   ORDER BY p.issued_at DESC, p.id DESC
   LIMIT 100
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_prescriptions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_prescriptions() TO app_rw;
--> statement-breakpoint
-- One prescription of that patient with what the PDF needs: its identifier, its date, the stored
-- document and the encrypted content (the portal opens it with the key of the organization and puts
-- it in the document, never in a response). Only a prescription that still has a document to give.
CREATE FUNCTION app.portal_prescription(p_id uuid)
RETURNS TABLE (
  id uuid,
  patient_id uuid,
  status text,
  prescription_date date,
  external_id text,
  issued_at timestamp with time zone,
  simulated boolean,
  registered_manually boolean,
  document_key text,
  content_enc bytea
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id, p.patient_id, p.status, p.prescription_date, p.external_id, p.issued_at,
         p.simulated, p.registered_manually, p.document_key, p.content_enc
    FROM public.portal_link l
    JOIN public.portal_identity i
      ON i.tenant_id = l.tenant_id AND i.id = l.portal_identity_id AND i.status = 'active'
    JOIN public.prescription p
      ON p.tenant_id = l.tenant_id AND p.patient_id = l.patient_id
   WHERE l.tenant_id = current_setting('app.tenant_id')::uuid
     AND l.id = nullif(current_setting('app.portal_link_id', true), '')::uuid
     AND l.portal_identity_id = nullif(current_setting('app.portal_identity_id', true), '')::uuid
     AND l.status = 'active'
     AND (l.majority_review_on IS NULL OR l.majority_review_on > app.portal_today())
     AND p.id = p_id
     AND p.status IN ('issued', 'dispensed', 'expired')
     AND p.external_id IS NOT NULL
     AND p.issued_at IS NOT NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_prescription(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_prescription(uuid) TO app_rw;
--> statement-breakpoint
-- JD-S5 R1-A-T6: a draft that was cancelled before the provider ever confirmed it has no date of
-- issue, and reception has no business learning that it existed.
CREATE OR REPLACE FUNCTION app.reception_prescription_existence(p_patient uuid)
RETURNS TABLE (id uuid, status text, created_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id, p.status, p.created_at
    FROM public.prescription p
   WHERE p.tenant_id = current_setting('app.tenant_id')::uuid
     AND p.patient_id = p_patient
     AND p.status IN ('issued', 'cancelled', 'dispensed', 'expired')
     AND p.issued_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.tenant t
        WHERE t.id = p.tenant_id
          AND t.settings -> 'reception_sees_clinical_metadata' = 'true'::jsonb
     )
     AND EXISTS (
       SELECT 1 FROM public.membership m
        WHERE m.tenant_id = p.tenant_id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          AND m.status = 'active'
          AND 'reception' = ANY (m.roles)
     )
   ORDER BY p.created_at DESC, p.id DESC
$$;
