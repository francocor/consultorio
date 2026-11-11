CREATE TABLE "matricula_operator_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matricula_operator_note_length_check" CHECK (char_length("matricula_operator_note"."note") <= 500),
	CONSTRAINT "matricula_operator_note_professional_fkey" FOREIGN KEY ("target_tenant_id","professional_id") REFERENCES "public"."professional"("tenant_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "matricula_operator_note_professional_key" ON "matricula_operator_note" USING btree ("target_tenant_id","professional_id");
--> statement-breakpoint
-- The note belongs to the platform, like the operator's sessions and trail: no tenant column, no row
-- level security, and no privilege for the application role (it gets every privilege on a new table
-- by default, migration 0000). The organization that is the subject of a note never reads it, writes
-- it or deletes it. The operator role reads the table, adds a row and changes only the text and who
-- wrote it. A note goes away only with its professional (the demo reset).
REVOKE ALL ON "matricula_operator_note" FROM app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON "matricula_operator_note" TO app_operator;
--> statement-breakpoint
GRANT UPDATE ("note", "updated_by", "updated_at") ON "matricula_operator_note" TO app_operator;
--> statement-breakpoint
-- Verifying a registration with the issuing authority needs the NAME of the professional, which
-- lives on the membership (the operator role has no privilege on it, on purpose). This returns that
-- one text for one professional of the transaction's own organization and nothing else: like every
-- tenant function it sees only the rows of the tenant the transaction is about. Only the operator
-- console may run it.
CREATE FUNCTION app.operator_professional_name(p_professional uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT m.display_name
      FROM public.professional p
      JOIN public.membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
     WHERE p.id = p_professional
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_professional_name(uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_professional_name(uuid) TO app_operator;

--> statement-breakpoint
-- The operator writes into an organization's own trail only the entries its work produces
-- (migration 0017: creating the organization and using a support grant). Vouching for a
-- registration is a third one: the owner reads "matricula verified" next to the other changes to
-- the professional's profile. A withdrawal is recorded in the platform trail only.
DROP POLICY "operator_audit_scope" ON "audit_event";
--> statement-breakpoint
CREATE POLICY "operator_audit_scope" ON "audit_event" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK ("action" IN ('tenant.created', 'support.access', 'matricula.verified'));
