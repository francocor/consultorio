-- Judgment Day, Stage 2, round 1, finding C3: a clinical document is part of the clinical record, so
-- it leaves the same footprint a note or an anamnesis does (decision D20).
--
-- The footprint answers "has anybody written about this patient?", and the first encounter of a
-- patient nobody has written about is the one exception to needing a care relationship. Documents
-- were not counted, so a patient with only clinical documents (and no active relationship) still
-- looked untouched to the encounter guard. The same definer function the notes use marks it, now
-- also when a document is written as clinical and when an administrative one becomes clinical.
CREATE TRIGGER document_footprint AFTER INSERT ON "document"
  FOR EACH ROW WHEN (NEW.classification = 'clinical')
  EXECUTE FUNCTION app.clinical_footprint_mark();
--> statement-breakpoint
CREATE TRIGGER document_footprint_reclassified AFTER UPDATE OF classification ON "document"
  FOR EACH ROW WHEN (NEW.classification = 'clinical' AND OLD.classification IS DISTINCT FROM NEW.classification)
  EXECUTE FUNCTION app.clinical_footprint_mark();
--> statement-breakpoint

-- Existing rows. A migration has no tenant context, so row level security is lifted on the two
-- tables for the length of this transaction (see migrations 0030 and 0033).
ALTER TABLE "document" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_footprint" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "clinical_footprint" (tenant_id, patient_id)
  SELECT DISTINCT tenant_id, patient_id FROM "document" WHERE classification = 'clinical'
ON CONFLICT (tenant_id, patient_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE "clinical_footprint" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
