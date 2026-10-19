-- Judgment day, Stage 5, round 2 (JD-S5 R2, B-S5): the prescriptions the portal lists were the first
-- hundred of the patient and nothing after them. The function now takes a keyset cursor (the issue
-- date and the id of the last row of the previous page) and a limit; it still answers only for the
-- link and the identity bound to the transaction, which it checks against the tables, and still
-- returns no medication. The default values keep `app.portal_prescriptions()` working as before: the
-- first page. The caller asks for one row more than a page to know whether there is another.
DROP FUNCTION app.portal_prescriptions();
--> statement-breakpoint
CREATE FUNCTION app.portal_prescriptions(
  p_before_issued_at timestamp with time zone DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
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
     AND (
       p_before_issued_at IS NULL
       OR p.issued_at < p_before_issued_at
       OR (p.issued_at = p_before_issued_at AND p.id < p_before_id)
     )
   ORDER BY p.issued_at DESC, p.id DESC
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 101)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_prescriptions(timestamp with time zone, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_prescriptions(timestamp with time zone, uuid, integer) TO app_rw;
