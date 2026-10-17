-- A document that came with an appointment points at it by the composite key, so it cannot name an
-- appointment of another organization or one that does not exist. `encounter_id` stays without a
-- foreign key until the clinical record exists.
--
-- The check of the existing rows runs as the table owner, and FORCE ROW LEVEL SECURITY binds the
-- owner on both tables: their tenant policy would read an `app.tenant_id` nobody set. Row level
-- security is lifted for the length of this one statement, inside the migration's transaction, and
-- put back at once.
ALTER TABLE "document" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
