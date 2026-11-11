-- Judgment day, Stage 5, round 2 (JD-S5 R2-2): the record of a patient says where the notices of the
-- portal go and who is an adult, and the staff can edit both. A trigger of `patient` writes a row
-- here, in the same transaction as the change and whoever makes it, whenever the e-mail or the birth
-- date moves:
--
--   - the address the record HAD is told (no link; the worker sends the notice and clears the
--     address), because a notice that goes to an address that was just replaced goes to whoever
--     replaced it;
--   - for seven days, giving anybody access to that patient through the portal needs an owner or an
--     administrator.
--
-- Nothing is deleted. A row may only be marked as told.
CREATE TABLE "patient_record_change" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"email_changed" boolean NOT NULL,
	"birth_date_changed" boolean NOT NULL,
	"notice_email" "citext",
	"notice_sent_at" timestamp with time zone,
	CONSTRAINT "patient_record_change_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_record_change_what_check" CHECK ("patient_record_change"."email_changed" or "patient_record_change"."birth_date_changed"),
	CONSTRAINT "patient_record_change_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "patient_record_change_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "patient_record_change_patient_idx" ON "patient_record_change" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "patient_record_change_pending_idx" ON "patient_record_change" USING btree ("created_at") WHERE "patient_record_change"."notice_email" is not null;
--> statement-breakpoint
ALTER TABLE "patient_record_change" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_record_change" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_record_change" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "patient_record_change" FROM app_rw;
--> statement-breakpoint
CREATE FUNCTION app.patient_record_changed() RETURNS trigger
  LANGUAGE plpgsql
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
      (tenant_id, patient_id, email_changed, birth_date_changed, notice_email)
    VALUES (NEW.tenant_id, NEW.id, email_moved, birth_moved, before_email);
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER patient_record_changed AFTER UPDATE OF email, birth_date ON "patient"
  FOR EACH ROW WHEN (NEW.email IS DISTINCT FROM OLD.email OR NEW.birth_date IS DISTINCT FROM OLD.birth_date)
  EXECUTE FUNCTION app.patient_record_changed();
--> statement-breakpoint
-- What a row may become: it is told (the address is cleared and the day is written), nothing else.
CREATE FUNCTION app.patient_record_change_guard() RETURNS trigger
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
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER patient_record_change_guard BEFORE UPDATE ON "patient_record_change"
  FOR EACH ROW EXECUTE FUNCTION app.patient_record_change_guard();
