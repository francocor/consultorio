-- The documents the staff share with a patient (Stage 5, track B, task 5.32). A share is ended, never
-- deleted. The portal reads a shared document through two functions below and not through the table
-- `document`: a clinical document is invisible to every transaction that is not a professional's
-- (RESTRICTIVE policies), and the patient's session is not one. Each function answers only for the
-- link and the identity that the request validated (`app.portal_link_id` and
-- `app.portal_identity_id`, set by `withPortalSubject` in the same transaction), so a bug that
-- passes the wrong id has nothing to pass: there is no parameter that names a patient or a link.
CREATE TABLE "document_share" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"shared_by" uuid NOT NULL,
	"unshared_at" timestamp with time zone,
	"unshared_by" uuid,
	CONSTRAINT "document_share_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_share_unshared_check" CHECK (("document_share"."unshared_at" is null) = ("document_share"."unshared_by" is null)),
	CONSTRAINT "document_share_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id"),
	CONSTRAINT "document_share_document_fkey" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id"),
	CONSTRAINT "document_share_patient_fkey" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_share_live_key" ON "document_share" USING btree ("tenant_id","document_id") WHERE "document_share"."unshared_at" is null;--> statement-breakpoint
CREATE INDEX "document_share_patient_idx" ON "document_share" USING btree ("tenant_id","patient_id") WHERE "document_share"."unshared_at" is null;
--> statement-breakpoint
ALTER TABLE "document_share" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_share" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_share" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "document_share" FROM app_rw;
--> statement-breakpoint
-- The metadata of the documents shared with the patient of the link of this request: name, category,
-- size and when it was shared. No storage key, no hash. A document that is not available (scanned
-- clean), was never confirmed, was abandoned or was hidden is not offered, shared or not.
CREATE FUNCTION app.portal_shared_documents()
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
     AND d.status = 'available'
     AND d.upload_completed_at IS NOT NULL
     AND d.abandoned_at IS NULL
     AND d.hidden_at IS NULL
   ORDER BY s.created_at DESC, d.id DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_shared_documents() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_shared_documents() TO app_rw;
--> statement-breakpoint
-- One shared document of that patient, with what is needed to stream it: the key of the object and
-- its type. Same conditions as the list, checked again when a link is used, because sharing can end
-- inside the five minutes of a link.
CREATE FUNCTION app.portal_shared_document(p_document uuid)
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
     AND d.id = p_document
     AND d.status = 'available'
     AND d.upload_completed_at IS NOT NULL
     AND d.abandoned_at IS NULL
     AND d.hidden_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.portal_shared_document(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.portal_shared_document(uuid) TO app_rw;
