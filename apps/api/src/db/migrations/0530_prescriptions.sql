CREATE TABLE "erx_connection" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"credentials_enc" "bytea",
	"status" text DEFAULT 'inactive' NOT NULL,
	"connected_at" timestamp with time zone,
	CONSTRAINT "erx_connection_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "erx_connection_status_check" CHECK ("erx_connection"."status" in ('active', 'inactive')),
	CONSTRAINT "erx_connection_provider_key_check" CHECK ("erx_connection"."provider_key" ~ '^[a-z][a-z0-9_-]{0,39}$'),
	CONSTRAINT "erx_connection_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_professional_id" uuid NOT NULL,
	"encounter_id" uuid,
	"client_key" uuid NOT NULL,
	"status" text DEFAULT 'pending_submission' NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	"content_enc" "bytea" NOT NULL,
	"prescription_date" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_id" text,
	"issued_at" timestamp with time zone,
	"registered_manually" boolean DEFAULT false NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"rejection_message" text,
	"cancel_reason_enc" "bytea",
	"cancelled_at" timestamp with time zone,
	"delivery_state" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"document_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "prescription_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prescription_status_check" CHECK ("status" in ('draft', 'pending_submission', 'issued', 'cancelled', 'dispensed', 'expired')),
	CONSTRAINT "prescription_visibility_check" CHECK ("prescription"."visibility" = 'default'),
	CONSTRAINT "prescription_delivery_state_check" CHECK ("delivery_state" is null or "delivery_state" in ('retrying', 'awaiting_reconciliation', 'needs_attention')),
	CONSTRAINT "prescription_state_check" CHECK ((
        ("prescription"."status" in ('draft', 'pending_submission')
          and "prescription"."issued_at" is null)
        or ("prescription"."status" in ('issued', 'dispensed', 'expired')
          and "prescription"."external_id" is not null and "prescription"."issued_at" is not null)
        or ("prescription"."status" = 'cancelled')
      )
      and (("prescription"."status" = 'cancelled') = ("prescription"."cancel_reason_enc" is not null))
      and (("prescription"."status" = 'cancelled') = ("prescription"."cancelled_at" is not null))
      and ("prescription"."registered_manually" = false or "prescription"."external_id" is not null)
      and ("prescription"."delivery_state" is null or "prescription"."status" in ('draft', 'pending_submission'))),
	CONSTRAINT "prescription_attempts_check" CHECK ("prescription"."attempts" >= 0),
	CONSTRAINT "prescription_version_check" CHECK ("prescription"."version" >= 1),
	CONSTRAINT "prescription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "prescription_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "prescription_author_fkey" FOREIGN KEY ("tenant_id","author_professional_id") REFERENCES "public"."professional"("tenant_id","id"),
	CONSTRAINT "prescription_encounter_fkey" FOREIGN KEY ("tenant_id","encounter_id") REFERENCES "public"."encounter"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "erx_connection_tenant_key" ON "erx_connection" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_client_key" ON "prescription" USING btree ("tenant_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_idempotency_key" ON "prescription" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_external_key" ON "prescription" USING btree ("tenant_id","external_id") WHERE "prescription"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "prescription_patient_idx" ON "prescription" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "prescription_author_idx" ON "prescription" USING btree ("tenant_id","author_professional_id","created_at");--> statement-breakpoint
CREATE INDEX "prescription_open_idx" ON "prescription" USING btree ("tenant_id","author_professional_id","next_attempt_at") WHERE "prescription"."status" in ('pending_submission', 'issued');
--> statement-breakpoint
ALTER TABLE "erx_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "erx_connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "erx_connection" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "prescription" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "prescription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "prescription" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Clinical backstop (ADR-003): on top of tenant isolation, only a health professional's transaction
-- sees a prescription, and only the ones the care relationship allows. The template kind is the
-- constant 'prescription', which app.clinical_readable never shares (decision D17): the sharing
-- scope of the organization never opens one. An owner, an admin or reception has no professional id,
-- so it reads zero rows of this table even if the application had a bug.
--
-- Two exceptions, the same ones the documents table has (0029): the worker acts as the system user
-- (the nil UUID that withTenant is given by the job runner) because the jobs that submit and settle
-- prescriptions run for every professional of the organization; and the owner role, because the two
-- definer functions below run as it (row level security binds the owner too, FORCE). The runtime
-- role has neither: no request ever carries the system user.
CREATE POLICY "clinical_professionals_only" ON "prescription" AS RESTRICTIVE USING (
  nullif(current_setting('app.professional_id', true), '') IS NOT NULL
  OR current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
  OR current_user = 'app_owner'
);
--> statement-breakpoint
CREATE POLICY "clinical_scope" ON "prescription" AS RESTRICTIVE USING (
  current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
  OR current_user = 'app_owner'
  OR app.clinical_readable("patient_id", "author_professional_id", "visibility", 'prescription'::text)
);
--> statement-breakpoint
-- What lets the lookup function below see across organizations: a read-only policy for the owner
-- (as for "message", 0392). The runtime role gets no policy beyond its tenant one.
CREATE POLICY "prescription_owner_lookup" ON "prescription" FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
-- A prescription is never deleted or emptied (only the privileged reset of a DEMO organization may,
-- the same exception the clinical tables have). The connection is switched off, never deleted.
REVOKE DELETE, TRUNCATE ON "prescription" FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "erx_connection" FROM app_rw;
--> statement-breakpoint
CREATE TRIGGER prescription_no_delete BEFORE DELETE ON "prescription"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER prescription_no_truncate BEFORE TRUNCATE ON "prescription"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
-- The rules of a prescription (e-prescription, "Immutability and cancellation"; decision D17), kept
-- in the database so that they hold for any role and any path, also against the owner:
--
-- - it is written by its own author (the application checks that the matricula is verified when it
--   is made and again every time the provider is about to be called);
-- - its identity never changes; the content of one the provider confirmed, its identifier and its
--   dates never change; a cancelled one keeps its reason;
-- - the status moves only along: draft -> pending_submission | cancelled, pending_submission ->
--   issued | draft | cancelled, issued -> cancelled | dispensed | expired. Nothing leaves cancelled,
--   dispensed or expired, and the content of a prescription waiting for the provider is the one it
--   will send;
-- - only the prescriber changes one, or the system (the worker settles what the provider reports).
--
-- Error codes: 23000 the rule "this never changes"; 42501 the wrong actor.
CREATE FUNCTION app.prescription_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    me uuid := nullif(current_setting('app.professional_id', true), '')::uuid;
    by_system boolean := current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000';
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

    IF me IS DISTINCT FROM OLD.author_professional_id AND NOT by_system AND current_user <> 'app_owner' THEN
      RAISE EXCEPTION 'only the prescriber changes a prescription' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.author_professional_id IS DISTINCT FROM OLD.author_professional_id
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.client_key IS DISTINCT FROM OLD.client_key
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      RAISE EXCEPTION 'the identity of a prescription never changes' USING ERRCODE = '23000';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('pending_submission', 'cancelled'))
      OR (OLD.status = 'pending_submission' AND NEW.status IN ('issued', 'draft', 'cancelled'))
      OR (OLD.status = 'issued' AND NEW.status IN ('cancelled', 'dispensed', 'expired'))
    ) THEN
      RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '23000';
    END IF;

    -- What the provider is about to be sent cannot be swapped under it; only a refused prescription
    -- (a draft) is corrected.
    IF OLD.status <> 'draft' AND (
         NEW.content_enc IS DISTINCT FROM OLD.content_enc
      OR NEW.prescription_date IS DISTINCT FROM OLD.prescription_date
    ) THEN
      RAISE EXCEPTION 'the content of a prescription changes only while it is a refused draft' USING ERRCODE = '23000';
    END IF;

    -- Once the provider confirmed it, what it says never changes.
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
CREATE TRIGGER prescription_guard BEFORE INSERT OR UPDATE ON "prescription"
  FOR EACH ROW EXECUTE FUNCTION app.prescription_guard();
--> statement-breakpoint
-- A notice from the provider carries its own identifier and no organization. This finds the
-- organization, the prescription and the prescriber of an identifier, and returns nothing else: no
-- patient, no content, no state. Owned by the role that owns the tables (the owner policy above lets
-- it see across organizations).
CREATE FUNCTION app.erx_prescription_by_external_id(p_external_id text)
RETURNS TABLE (tenant_id uuid, prescription_id uuid, professional_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.tenant_id, p.id, p.author_professional_id
    FROM public.prescription p
   WHERE p.external_id = p_external_id
   ORDER BY p.tenant_id, p.id
   LIMIT 5
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erx_prescription_by_external_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.erx_prescription_by_external_id(text) TO app_rw;
--> statement-breakpoint
-- That a prescription exists, for reception, when the organization has turned on "reception sees
-- clinical metadata": its id, its status and the day it was made. No medication, no prescriber, no
-- identifier. Nothing is returned unless BOTH hold, checked here and not in the application: the
-- setting is on, and the caller is an active reception member of this organization. An owner or an
-- admin gets zero rows whatever the setting says. A prescription nobody has confirmed yet (a draft
-- or one waiting for the provider) does not exist for reception.
CREATE FUNCTION app.reception_prescription_existence(p_patient uuid)
RETURNS TABLE (id uuid, status text, created_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id, p.status, p.created_at
    FROM public.prescription p
   WHERE p.tenant_id = current_setting('app.tenant_id')::uuid
     AND p.patient_id = p_patient
     AND p.status IN ('issued', 'cancelled', 'dispensed', 'expired')
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reception_prescription_existence(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reception_prescription_existence(uuid) TO app_rw;
