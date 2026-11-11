-- Judgment Day, Stage 2, round 1, finding S7: the clinical footprint is read by professionals only.
--
-- The footprint holds no clinical content, but it does say that somebody has written about a
-- patient. Reception, the administration and the owner have no business reading it, and only a
-- professional's transaction ever asks (the encounter guard and the note service). It gets the
-- restrictive "professionals only" policy of the clinical tables.
--
-- The definer triggers write the footprint as the owner, in whatever transaction wrote the note,
-- the anamnesis or the clinical document (a system job reclassifying a document has no
-- professional). An INSERT ... ON CONFLICT also evaluates the reading policies, so the owner (the
-- role of those functions, like in the document policy) is let through; the runtime role is not.
CREATE POLICY "clinical_professionals_only" ON "clinical_footprint" AS RESTRICTIVE FOR SELECT
  USING (
    nullif(current_setting('app.professional_id', true), '') IS NOT NULL
    OR current_user = 'app_owner'
  );
