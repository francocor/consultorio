-- Judgment day, Stage 5, round 1 (JD-S5 R1): the portal tables after the first adversarial review.
--
-- B-T7  The rules that were only code are in the database too: whose a link is, who a session
--       belongs to, which document is shared with which patient never change, and what was ended
--       stays ended.
-- S5-7  The age of majority is enforced where the data is read, not only by the daily job: the two
--       definer functions of the shared documents (0552) refuse a link whose review day has come,
--       and a correction of a birth date moves the review day of the links that have one.

-- A link keeps its identity, its patient and its relationship; a revoked link stays revoked.
CREATE FUNCTION app.portal_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.portal_identity_id IS DISTINCT FROM OLD.portal_identity_id
       OR NEW.relationship IS DISTINCT FROM OLD.relationship THEN
      RAISE EXCEPTION 'the identity, the patient and the relationship of a portal link never change' USING ERRCODE = '23000';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'a revoked portal link stays revoked' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER portal_link_guard BEFORE UPDATE ON "portal_link"
  FOR EACH ROW EXECUTE FUNCTION app.portal_link_guard();
--> statement-breakpoint
-- A session belongs to one identity for good, keeps its token, stays ended once ended, and can only
-- point at a link of its own identity. (The subject it points at does change when the person picks
-- another record, so what is fixed is whose links it may point at.)
CREATE FUNCTION app.portal_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.portal_identity_id IS DISTINCT FROM OLD.portal_identity_id
         OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
        RAISE EXCEPTION 'the identity and the token of a portal session never change' USING ERRCODE = '23000';
      END IF;
      IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'an ended portal session stays ended' USING ERRCODE = '23000';
      END IF;
    END IF;
    IF NEW.selected_link_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.selected_link_id IS DISTINCT FROM OLD.selected_link_id) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.portal_link l
         WHERE l.tenant_id = NEW.tenant_id
           AND l.id = NEW.selected_link_id
           AND l.portal_identity_id = NEW.portal_identity_id
      ) THEN
        RAISE EXCEPTION 'a portal session reads only the links of its own identity' USING ERRCODE = '23000';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER portal_session_guard BEFORE INSERT OR UPDATE ON "portal_session"
  FOR EACH ROW EXECUTE FUNCTION app.portal_session_guard();
--> statement-breakpoint
-- A share names one document and one patient for good; once ended it is not shared again (a new
-- share is a new row, the live key allows it).
CREATE FUNCTION app.document_share_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.shared_by IS DISTINCT FROM OLD.shared_by THEN
      RAISE EXCEPTION 'the document and the patient of a share never change' USING ERRCODE = '23000';
    END IF;
    IF OLD.unshared_at IS NOT NULL
       AND (NEW.unshared_at IS DISTINCT FROM OLD.unshared_at OR NEW.unshared_by IS DISTINCT FROM OLD.unshared_by) THEN
      RAISE EXCEPTION 'an ended share stays ended' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER document_share_guard BEFORE UPDATE ON "document_share"
  FOR EACH ROW EXECUTE FUNCTION app.document_share_guard();
--> statement-breakpoint
-- The day a dependent reaches the age of majority, for a birth date (the age is 18, the one of the
-- only country pack there is). Somebody born on 29 February has the birthday on 1 March in a year
-- that has no 29th, the same rule as `majorityReviewDate` of the portal module.
CREATE FUNCTION app.majority_review_date(p_birth date, p_age integer) RETURNS date
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE
      WHEN extract(month FROM p_birth) = 2 AND extract(day FROM p_birth) = 29
        AND NOT (
          (extract(year FROM p_birth)::int + p_age) % 4 = 0
          AND ((extract(year FROM p_birth)::int + p_age) % 100 <> 0
               OR (extract(year FROM p_birth)::int + p_age) % 400 = 0)
        )
      THEN make_date(extract(year FROM p_birth)::int + p_age, 3, 1)
      ELSE make_date(
        extract(year FROM p_birth)::int + p_age,
        extract(month FROM p_birth)::int,
        extract(day FROM p_birth)::int
      )
    END
  $$;
--> statement-breakpoint
-- The trigger below runs as whoever corrects the birth date, and calls this function: schema `app`
-- gives nobody EXECUTE by default.
REVOKE ALL ON FUNCTION app.majority_review_date(date, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.majority_review_date(date, integer) TO app_rw;
--> statement-breakpoint
-- A correction of a birth date moves the review day of the representative links that have one (a
-- link with none was authorized by the adult and stays so). The portal also reads the day itself, so
-- a link whose day has come reads nothing before the daily job suspends it.
CREATE FUNCTION app.patient_birth_date_changed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    UPDATE public.portal_link
       SET majority_review_on = app.majority_review_date(NEW.birth_date, 18)
     WHERE tenant_id = NEW.tenant_id
       AND patient_id = NEW.id
       AND relationship = 'representative'
       AND status IN ('active', 'suspended')
       AND majority_review_on IS NOT NULL;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER patient_birth_date_changed AFTER UPDATE OF birth_date ON "patient"
  FOR EACH ROW WHEN (NEW.birth_date IS DISTINCT FROM OLD.birth_date)
  EXECUTE FUNCTION app.patient_birth_date_changed();
--> statement-breakpoint
-- The shared documents of 0552 with the same rule as the rest of the portal: a representative link
-- past the day of majority of its patient reads nothing, whether or not the daily job has run.
CREATE OR REPLACE FUNCTION app.portal_shared_documents()
RETURNS TABLE (
  id uuid,
  category text,
  original_name text,
  content_type text,
  size_bytes integer,
  shared_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.category, d.original_name, d.content_type, d.size_bytes, s.created_at
    FROM public.portal_link l
    JOIN public.portal_identity i
      ON i.tenant_id = l.tenant_id AND i.id = l.portal_identity_id AND i.status = 'active'
    JOIN public.document_share s
      ON s.tenant_id = l.tenant_id AND s.patient_id = l.patient_id AND s.unshared_at IS NULL
    JOIN public.document d
      ON d.tenant_id = s.tenant_id AND d.id = s.document_id AND d.patient_id = l.patient_id
   WHERE l.tenant_id = current_setting('app.tenant_id')::uuid
     AND l.id = nullif(current_setting('app.portal_link_id', true), '')::uuid
     AND l.portal_identity_id = nullif(current_setting('app.portal_identity_id', true), '')::uuid
     AND l.status = 'active'
     AND (l.majority_review_on IS NULL OR l.majority_review_on > app.portal_today())
     AND d.status = 'available'
     AND d.upload_completed_at IS NOT NULL
     AND d.abandoned_at IS NULL
     AND d.hidden_at IS NULL
   ORDER BY s.created_at DESC, d.id DESC
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.portal_shared_document(p_document uuid)
RETURNS TABLE (
  id uuid,
  patient_id uuid,
  category text,
  original_name text,
  content_type text,
  size_bytes integer,
  object_key text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.patient_id, d.category, d.original_name, d.content_type, d.size_bytes, d.object_key
    FROM public.portal_link l
    JOIN public.portal_identity i
      ON i.tenant_id = l.tenant_id AND i.id = l.portal_identity_id AND i.status = 'active'
    JOIN public.document_share s
      ON s.tenant_id = l.tenant_id AND s.patient_id = l.patient_id AND s.unshared_at IS NULL
    JOIN public.document d
      ON d.tenant_id = s.tenant_id AND d.id = s.document_id AND d.patient_id = l.patient_id
   WHERE l.tenant_id = current_setting('app.tenant_id')::uuid
     AND l.id = nullif(current_setting('app.portal_link_id', true), '')::uuid
     AND l.portal_identity_id = nullif(current_setting('app.portal_identity_id', true), '')::uuid
     AND l.status = 'active'
     AND (l.majority_review_on IS NULL OR l.majority_review_on > app.portal_today())
     AND d.id = p_document
     AND d.status = 'available'
     AND d.upload_completed_at IS NOT NULL
     AND d.abandoned_at IS NULL
     AND d.hidden_at IS NULL
$$;
