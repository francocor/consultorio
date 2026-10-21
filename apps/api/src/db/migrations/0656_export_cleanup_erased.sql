-- Stage 6, judgment day round 2 (JD-S6 R2-3): the plaintext export of an organization whose archive was
-- erased whole is removed too.
--
-- 0687 listed the organizations whose export is due for removal only when their archive was verified and
-- NOT erased. A legal erasure of the whole archive therefore left the plaintext zip in the bucket for
-- ever: the copy that replaces it is gone, and so is the reason to keep this one. An erased archive now
-- counts like a verified one, once the download window has passed.
CREATE OR REPLACE FUNCTION app.export_cleanup_due(p_after_days integer, p_limit integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT e.tenant_id
      FROM public.export_package e
      JOIN public.tenant_archive a ON a.tenant_id = e.tenant_id
     WHERE e.status = 'ready'
       AND e.object_removed_at IS NULL
       AND a.status = 'written'
       AND (
            a.erased_at IS NOT NULL
         OR (a.verify_status = 'ok' AND a.verified_at IS NOT NULL)
       )
       -- The download window counts from the request of the export (the cancellation).
       AND EXISTS (
         SELECT 1 FROM public.export_package r
          WHERE r.tenant_id = e.tenant_id AND r.kind = 'administrative'
            AND r.created_at <= now() - make_interval(days => greatest(p_after_days, 0))
       )
     ORDER BY e.tenant_id
     LIMIT greatest(least(p_limit, 500), 1)
  $$;
