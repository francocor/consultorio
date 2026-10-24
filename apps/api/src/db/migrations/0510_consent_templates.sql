CREATE TABLE "consent_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"draft_body" text DEFAULT '' NOT NULL,
	"specialty" text,
	"appointment_type_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"starter_key" text,
	"created_by" uuid NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	CONSTRAINT "consent_template_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_template_status_check" CHECK ("consent_template"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "consent_template_title_check" CHECK (length(btrim("consent_template"."title")) between 1 and 160),
	CONSTRAINT "consent_template_body_check" CHECK (length("consent_template"."draft_body") <= 20000),
	CONSTRAINT "consent_template_specialty_check" CHECK ("consent_template"."specialty" is null or "consent_template"."specialty" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "consent_template_retired_check" CHECK (("consent_template"."status" = 'retired') = ("consent_template"."retired_at" is not null and "consent_template"."retired_by" is not null)),
	CONSTRAINT "consent_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
CREATE TABLE "consent_template_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid NOT NULL,
	CONSTRAINT "consent_template_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_template_version_tenant_id_template_id_number_key" UNIQUE("tenant_id","template_id","version_number"),
	CONSTRAINT "consent_template_version_number_check" CHECK ("consent_template_version"."version_number" >= 1),
	CONSTRAINT "consent_template_version_hash_check" CHECK ("consent_template_version"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consent_template_version_title_check" CHECK (length(btrim("consent_template_version"."title")) between 1 and 160),
	CONSTRAINT "consent_template_version_body_check" CHECK (length(btrim("consent_template_version"."body")) between 1 and 20000),
	CONSTRAINT "consent_template_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id")
);
--> statement-breakpoint
ALTER TABLE "consent_template_version" ADD CONSTRAINT "consent_template_version_template_fkey" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."consent_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_template_list_idx" ON "consent_template" USING btree ("tenant_id","status","title");
--> statement-breakpoint
ALTER TABLE "consent_template" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_template" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_template" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "consent_template_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_template_version" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_template_version" USING ("tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- Consent templates and their versions (informed-consent, "Consent template authoring" and
-- "Template versioning"). Error codes, as in the clinical tables: 23000 is the rule "this never
-- changes", 42501 the privilege the runtime role no longer has.

-- A template is retired, never deleted: the runtime role has no DELETE or TRUNCATE on it.
REVOKE DELETE, TRUNCATE ON "consent_template" FROM app_rw;
--> statement-breakpoint
-- A published version is the text somebody signs, so it never changes and is never deleted, by any
-- role. The runtime role loses the privileges; the triggers below also stop the migration owner
-- (the privileged reset of a DEMO organization is the one exception, as for the clinical tables).
REVOKE UPDATE, DELETE, TRUNCATE ON "consent_template_version" FROM app_rw;
--> statement-breakpoint
-- What a template may become. Who made it and where it came from are fixed. Draft goes to
-- published, and either goes to retired; nothing comes back, and a retired template does not
-- change at all. The title and the working copy of the text are edited until it is retired.
CREATE FUNCTION app.guard_consent_template() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.starter_key IS DISTINCT FROM OLD.starter_key THEN
      RAISE EXCEPTION 'who made a template, and where it comes from, never change' USING ERRCODE = '23000';
    END IF;
    IF OLD.status = 'retired' THEN
      RAISE EXCEPTION 'a retired template does not change' USING ERRCODE = '23000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'retired'))
                OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'this change of status is not allowed' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_template_guard
  BEFORE UPDATE ON "consent_template"
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent_template();
--> statement-breakpoint
CREATE FUNCTION app.consent_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    RAISE EXCEPTION '% rows never change', TG_TABLE_NAME USING ERRCODE = '23000';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_template_version_immutable
  BEFORE UPDATE ON "consent_template_version"
  FOR EACH ROW EXECUTE FUNCTION app.consent_immutable();
--> statement-breakpoint
CREATE TRIGGER consent_template_no_delete BEFORE DELETE ON "consent_template"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER consent_template_version_no_delete BEFORE DELETE ON "consent_template_version"
  FOR EACH ROW EXECUTE FUNCTION app.clinical_no_delete();
--> statement-breakpoint
CREATE TRIGGER consent_template_no_truncate BEFORE TRUNCATE ON "consent_template"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
--> statement-breakpoint
CREATE TRIGGER consent_template_version_no_truncate BEFORE TRUNCATE ON "consent_template_version"
  FOR EACH STATEMENT EXECUTE FUNCTION app.clinical_no_truncate();
