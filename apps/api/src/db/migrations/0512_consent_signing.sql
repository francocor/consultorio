CREATE TABLE "consent_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"appointment_id" uuid,
	"encounter_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_by" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "consent_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_request_status_check" CHECK ("consent_request"."status" in ('pending', 'signed', 'declined', 'expired', 'revoked')),
	CONSTRAINT "consent_request_method_check" CHECK ("consent_request"."method" in ('in_person', 'portal')),
	CONSTRAINT "consent_request_state_check" CHECK ((
        ("consent_request"."status" = 'pending'
          and "consent_request"."signed_at" is null and "consent_request"."revoked_at" is null and "consent_request"."closed_at" is null)
        or ("consent_request"."status" = 'signed'
          and "consent_request"."signed_at" is not null and "consent_request"."revoked_at" is null and "consent_request"."closed_at" is null)
        or ("consent_request"."status" = 'revoked'
          and "consent_request"."signed_at" is not null and "consent_request"."revoked_at" is not null and "consent_request"."closed_at" is null)
        or ("consent_request"."status" in ('declined', 'expired')
          and "consent_request"."signed_at" is null and "consent_request"."revoked_at" is null and "consent_request"."closed_at" is not null)
      )),
	CONSTRAINT "consent_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "consent_request_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "consent_request_version_fkey" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."consent_template_version"("tenant_id","id"),
	CONSTRAINT "consent_request_appointment_fkey" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointment"("tenant_id","id"),
	CONSTRAINT "consent_request_encounter_fkey" FOREIGN KEY ("tenant_id","encounter_id") REFERENCES "public"."encounter"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "consent_revocation" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"actor_user_id" uuid,
	"portal_identity_id" uuid,
	"reason_enc" "bytea",
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_revocation_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_revocation_tenant_id_request_id_key" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "consent_revocation_channel_check" CHECK ("consent_revocation"."channel" in ('in_person', 'portal')),
	CONSTRAINT "consent_revocation_actor_check" CHECK (("consent_revocation"."channel" = 'in_person' and "consent_revocation"."actor_user_id" is not null and "consent_revocation"."portal_identity_id" is null)
        or ("consent_revocation"."channel" = 'portal' and "consent_revocation"."portal_identity_id" is not null and "consent_revocation"."actor_user_id" is null)),
	CONSTRAINT "consent_revocation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "consent_revocation_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "consent_signature" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"signer_kind" text NOT NULL,
	"accepted" boolean NOT NULL,
	"method" text NOT NULL,
	"payload_enc" "bytea" NOT NULL,
	"content_fingerprint" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"portal_identity_id" uuid,
	CONSTRAINT "consent_signature_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_signature_tenant_id_request_id_key" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "consent_signature_signer_check" CHECK ("consent_signature"."signer_kind" in ('patient', 'representative')),
	CONSTRAINT "consent_signature_method_check" CHECK ("consent_signature"."method" in ('in_person', 'portal')),
	CONSTRAINT "consent_signature_accepted_check" CHECK ("consent_signature"."accepted" = true),
	CONSTRAINT "consent_signature_fingerprint_check" CHECK ("consent_signature"."content_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consent_signature_recorder_check" CHECK (("consent_signature"."method" = 'in_person' and "consent_signature"."recorded_by" is not null and "consent_signature"."portal_identity_id" is null)
        or ("consent_signature"."method" = 'portal' and "consent_signature"."portal_identity_id" is not null and "consent_signature"."recorded_by" is null)),
	CONSTRAINT "consent_signature_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "consent_signature_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id"),
	CONSTRAINT "consent_signature_version_fkey" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."consent_template_version"("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "appointment_type" ADD COLUMN "requires_consent_template_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_revocation" ADD CONSTRAINT "consent_revocation_request_fkey" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."consent_request"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_signature" ADD CONSTRAINT "consent_signature_request_fkey" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."consent_request"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_request_patient_idx" ON "consent_request" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_request_version_idx" ON "consent_request" USING btree ("tenant_id","template_version_id");--> statement-breakpoint
CREATE INDEX "consent_request_pending_expiry_idx" ON "consent_request" USING btree ("tenant_id","expires_at") WHERE "consent_request"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "consent_request_pending_key" ON "consent_request" USING btree ("tenant_id","patient_id","template_version_id") WHERE "consent_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "consent_revocation_patient_idx" ON "consent_revocation" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "consent_signature_patient_idx" ON "consent_signature" USING btree ("tenant_id","patient_id");
--> statement-breakpoint
ALTER TABLE "consent_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_request" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "consent_signature" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_signature" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_signature" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "consent_revocation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_revocation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_revocation" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- The consent an appointment type requires must be a template of the same organization. It is a
-- trigger and not a composite foreign key because a key from appointment_type to consent_template
-- (both with FORCE row level security) would need row level security lifted on both tables for the
-- length of the migration, and its table would point back at the one that points at it. A template
-- of another organization is invisible to the transaction, so it is "not found", the answer a
-- missing parent key gives.
CREATE FUNCTION app.guard_appointment_type_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.requires_consent_template_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.consent_template t
          WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.requires_consent_template_id
       ) THEN
      RAISE EXCEPTION 'the consent an appointment type requires must be a template of the organization'
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER appointment_type_consent_guard
  BEFORE INSERT OR UPDATE OF requires_consent_template_id ON "appointment_type"
  FOR EACH ROW EXECUTE FUNCTION app.guard_appointment_type_consent();
--> statement-breakpoint
--> statement-breakpoint
-- Requests, signatures and revocations of informed consent (informed-consent, "Signature capture
-- and binding", "Immutability of signed consents" and "Revocation"). Error codes, as in the clinical
-- tables: 23000 is the rule "this never changes", 23503 a row that does not match its parent (the
-- code the composite foreign keys use too), 42501 the privilege the runtime role no longer has.

-- A request is never deleted. A signature and a revocation never change and are never deleted,
-- by any role: the runtime role loses the privileges and the triggers below also stop the migration
-- owner (the privileged reset of a DEMO organization is the one exception, as for the clinical tables).
REVOKE DELETE, TRUNCATE ON "consent_request" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "consent_signature" FROM app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "consent_revocation" FROM app_rw;
--> statement-breakpoint
-- Reading a signature is clinical (informed-consent, "Visibility and access control"): the personal
-- content of the signed record is behind it. On top of the tenant policy, a row is visible to a
-- health professional when the care relationship or the sharing scope allow it (the same predicate
-- as a clinical note; a signature follows the general ceiling of the sharing scope), and to the
-- portal of the very patient it belongs to. Reception and the administration read no row, so they
-- see the status and the dates of a consent only, which live on the request. The policy is for
-- SELECT: whoever records a signing (the device at reception, the portal) can insert one without
-- being able to read it back.
CREATE POLICY "consent_signature_scope" ON "consent_signature" AS RESTRICTIVE FOR SELECT USING (
  (
    nullif(current_setting('app.professional_id', true), '') IS NOT NULL
    AND app.clinical_readable("patient_id", NULL::uuid, 'default', NULL::text)
  )
  OR "patient_id" = nullif(current_setting('app.consent_portal_patient', true), '')::uuid
);
--> statement-breakpoint
-- What a request may become. It starts pending. Who it is for, which version, how and until when
-- never change. A pending request ends declined or expired. It becomes signed and revoked only
-- through the signature and the revocation (their triggers update it, one trigger level down), so
-- nobody marks a consent signed or revoked by hand.
CREATE FUNCTION app.guard_consent_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'pending' THEN
        RAISE EXCEPTION 'a consent request starts pending' USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'who a consent is for, which version, how and until when never change' USING ERRCODE = '23000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'pending' AND NEW.status IN ('declined', 'expired') THEN
        NULL;
      ELSIF (OLD.status = 'pending' AND NEW.status = 'signed')
            OR (OLD.status = 'signed' AND NEW.status = 'revoked') THEN
        IF pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'a consent is signed by its signature and revoked by its revocation' USING ERRCODE = '23000';
        END IF;
      ELSE
        RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '23000';
      END IF;
    ELSIF NEW.signed_at IS DISTINCT FROM OLD.signed_at
          OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'the dates of a consent change with its status' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_request_guard
  BEFORE INSERT OR UPDATE ON "consent_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent_request();
--> statement-breakpoint
-- A signature is written once, for a pending request, repeating the request's patient, version and
-- method. The request is read with the tenant policy only, so this works for the device at reception
-- (not a professional) and for the portal. The signature then makes its request signed.
CREATE FUNCTION app.guard_consent_signature() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    parent public.consent_request%ROWTYPE;
  BEGIN
    SELECT * INTO parent FROM public.consent_request r
     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id;
    IF NOT FOUND
       OR parent.patient_id <> NEW.patient_id
       OR parent.template_version_id <> NEW.template_version_id
       OR parent.method <> NEW.method THEN
      RAISE EXCEPTION 'a signature must match its request' USING ERRCODE = '23503';
    END IF;
    IF parent.status <> 'pending' THEN
      RAISE EXCEPTION 'only a pending request is signed' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_signature_guard
  BEFORE INSERT ON "consent_signature"
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent_signature();
--> statement-breakpoint
CREATE FUNCTION app.consent_signature_applied() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    UPDATE public.consent_request
       SET status = 'signed', signed_at = NEW.signed_at, updated_at = now()
     WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_signature_applied
  AFTER INSERT ON "consent_signature"
  FOR EACH ROW EXECUTE FUNCTION app.consent_signature_applied();
--> statement-breakpoint
-- A revocation is written once, for a signed request, repeating the request's patient. It makes
-- its request revoked and leaves the signature as it was.
CREATE FUNCTION app.guard_consent_revocation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    parent public.consent_request%ROWTYPE;
  BEGIN
    SELECT * INTO parent FROM public.consent_request r
     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id;
    IF NOT FOUND OR parent.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'a revocation must match its request' USING ERRCODE = '23503';
    END IF;
    IF parent.status <> 'signed' THEN
      RAISE EXCEPTION 'only a signed consent is revoked, and once' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_revocation_guard
  BEFORE INSERT ON "consent_revocation"
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent_revocation();
--> statement-breakpoint
CREATE FUNCTION app.consent_revocation_applied() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    UPDATE public.consent_request
       SET status = 'revoked', revoked_at = NEW.revoked_at, updated_at = now()
     WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_revocation_applied
  AFTER INSERT ON "consent_revocation"
  FOR EACH ROW EXECUTE FUNCTION app.consent_revocation_applied();
--> statement-breakpoint
CREATE TRIGGER consent_signature_immutable
  BEFORE UPDATE ON "consent_signature"
  FOR EACH ROW EXECUTE FUNCTION app.consent_immutable();
--> statement-breakpoint
CREATE TRIGGER consent_revocation_immutable
  BEFORE UPDATE ON "consent_revocation"
  FOR EACH ROW EXECUTE FUNCTION app.consent_immutable();
--> statement-breakpoint
CREATE TRIGGER consent_request_no_delete BEFORE DELETE ON "consent_request"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER consent_signature_no_delete BEFORE DELETE ON "consent_signature"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER consent_revocation_no_delete BEFORE DELETE ON "consent_revocation"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER consent_request_no_truncate BEFORE TRUNCATE ON "consent_request"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER consent_signature_no_truncate BEFORE TRUNCATE ON "consent_signature"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER consent_revocation_no_truncate BEFORE TRUNCATE ON "consent_revocation"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
