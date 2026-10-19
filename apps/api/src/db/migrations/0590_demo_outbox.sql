CREATE TABLE "demo_outbox" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "demo_outbox_tenant_idx" ON "demo_outbox" USING btree ("target_tenant_id","created_at","id");
--> statement-breakpoint
-- The email of the demo organizations is written by the application role and read by the provider
-- console with the same role (the console is the operator's door to the dev tools, see
-- docs/stage5-tracks.md). Nothing updates or deletes a row: the demo reset removes them, inside the
-- privileged function below. No tenant_id, no row level security: it is a platform table, like the
-- simulators', and it is never filled for a customer.
REVOKE UPDATE, DELETE, TRUNCATE ON "demo_outbox" FROM app_rw;
--> statement-breakpoint
-- app.demo_reset (migration 0018) with one more step: it removes the outbox rows of the organization
-- it resets. The signature, the owner, the search path and the grants (the operator console's role
-- only) are those of 0018; CREATE OR REPLACE keeps the grants.
CREATE OR REPLACE FUNCTION app.demo_reset(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_is_demo boolean;
  v_last_seq bigint;
  v_last_hash text;
  v_remaining text[];
  v_next text;
  v_count bigint;
  v_deleted jsonb := '{}'::jsonb;
BEGIN
  -- Row level security reads the tenant from here, for this transaction only.
  PERFORM set_config('app.tenant_id', p_tenant::text, true);

  SELECT t.is_demo INTO v_is_demo FROM public.tenant t WHERE t.id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_is_demo THEN
    RAISE EXCEPTION 'organization is not a demo organization' USING ERRCODE = '42501';
  END IF;

  -- The end of the chain being removed, for the platform trail.
  SELECT e.seq, e.hash INTO v_last_seq, v_last_hash
    FROM public.audit_event e
   WHERE e.tenant_id = p_tenant AND e.seq IS NOT NULL
   ORDER BY e.seq DESC
   LIMIT 1;

  -- The append-only trigger of the audit trail lets this one transaction, running as the owner,
  -- delete the rows of this one demo organization.
  PERFORM set_config('app.demo_reset', p_tenant::text, true);

  -- Every table that carries a tenant_id, except the organization's own configuration.
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[]) INTO v_remaining
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND n.nspname = 'public'
     AND c.relname NOT IN ('tenant', 'tenant_key', 'tenant_feature');

  WHILE cardinality(v_remaining) > 0 LOOP
    -- A table that no other remaining table points at can be emptied now.
    SELECT t.name INTO v_next
      FROM unnest(v_remaining) AS t(name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_constraint k
         JOIN pg_class child ON child.oid = k.conrelid
         JOIN pg_class parent ON parent.oid = k.confrelid
         JOIN pg_namespace pn ON pn.oid = parent.relnamespace
        WHERE k.contype = 'f'
          AND pn.nspname = 'public'
          AND parent.relname = t.name
          AND child.relname = ANY (v_remaining)
          AND child.relname <> t.name
     )
     ORDER BY t.name
     LIMIT 1;
    IF v_next IS NULL THEN
      RAISE EXCEPTION 'tenant tables reference each other in a cycle: %', v_remaining;
    END IF;

    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_next);
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id = $1', v_next) USING p_tenant;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_next);

    IF v_count > 0 THEN
      v_deleted := v_deleted || jsonb_build_object(v_next, v_count);
    END IF;
    v_remaining := array_remove(v_remaining, v_next);
  END LOOP;

  -- The demo outbox (migration 0590) is a platform table with no tenant_id, so the loop above does not
  -- see it: the messages the organization 'sent' go with the rest of its content.
  DELETE FROM public.demo_outbox WHERE target_tenant_id = p_tenant;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    v_deleted := v_deleted || jsonb_build_object('demo_outbox', v_count);
  END IF;

  RETURN jsonb_build_object('lastSeq', v_last_seq, 'lastHash', v_last_hash, 'deleted', v_deleted);
END
$$;
