-- Judgment Day, Stage 2, round 2, finding C2: the database refuses to hide a clinical document
-- for anyone but its author or a professional who treats the patient.
--
-- The use case already requires authorship or a care relationship to hide a clinical document, but
-- the row guard only knew the status change (available to hidden), not who made it. A path that
-- skips the use case could hide a document the actor only reads through sharing. The guard now
-- repeats the rule of the reclassification: the acting professional must have written the document
-- or treat the patient. The system user (the scan, the cleanup) never hides a document, so it gets
-- no exception. Every earlier check stays as it was.
CREATE OR REPLACE FUNCTION app.guard_document() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
       OR NEW.original_name IS DISTINCT FROM OLD.original_name
       OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
       OR NEW.replaces_document_id IS DISTINCT FROM OLD.replaces_document_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.author_professional_id IS NOT NULL
           AND NEW.author_professional_id IS DISTINCT FROM OLD.author_professional_id) THEN
      RAISE EXCEPTION 'a document keeps its identity' USING ERRCODE = '42501';
    END IF;
    IF OLD.upload_completed_at IS NOT NULL
       AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
      RAISE EXCEPTION 'the size of a confirmed upload does not change' USING ERRCODE = '42501';
    END IF;
    IF (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
       OR (OLD.content_type IS NOT NULL AND NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
      RAISE EXCEPTION 'the result of the scan is written once' USING ERRCODE = '42501';
    END IF;
    IF OLD.hidden_at IS NOT NULL
       AND (NEW.hidden_at IS DISTINCT FROM OLD.hidden_at
            OR NEW.hidden_by IS DISTINCT FROM OLD.hidden_by
            OR NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason) THEN
      RAISE EXCEPTION 'a hidden document keeps its reason' USING ERRCODE = '42501';
    END IF;
    IF NEW.object_key IS DISTINCT FROM OLD.object_key
       AND NOT (OLD.status = 'quarantined' AND NEW.status = 'available') THEN
      RAISE EXCEPTION 'the storage key moves only when the scan releases the file' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'quarantined' AND NEW.status IN ('available', 'rejected'))
                OR (OLD.status = 'available' AND NEW.status = 'hidden')) THEN
      RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '42501';
    END IF;
    IF OLD.classification = 'clinical' AND NEW.classification IS DISTINCT FROM OLD.classification
       AND (me IS NULL
            OR NOT (OLD.author_professional_id = me OR app.is_treating(OLD.patient_id, me))) THEN
      RAISE EXCEPTION 'only the author or a treating professional takes a document out of the clinical record'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.classification = 'clinical' AND NEW.status = 'hidden' AND OLD.status IS DISTINCT FROM 'hidden'
       AND (me IS NULL
            OR NOT (OLD.author_professional_id = me OR app.is_treating(OLD.patient_id, me))) THEN
      RAISE EXCEPTION 'only the author or a treating professional hides a clinical document'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
