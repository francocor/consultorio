-- Resetting a demo organization (demo, "Reset to a known state"). Nothing in the application ever
-- deletes tenant data: patients, coverage, consents and the audit trail are append-only or
-- deactivated by design. A demo organization is the one exception, because its content is
-- fictitious and is regenerated from a seed. This function is the only way to do it.
--
-- It is SECURITY DEFINER (it runs as the migration owner, which owns every table) and:
--   * raises unless the organization is flagged `is_demo`, a flag that is fixed at creation;
--   * can be executed ONLY by the operator console's database role: not by the API or the worker
--     (app_rw), so no tenant user can reach it, whatever they hold;
--   * removes the rows of one organization only, in foreign key order, and says what it removed;
--   * keeps the organization row, its data key and its feature flags.
--
-- Row level security stays FORCED on every table for everyone else. The function lifts it for the
-- duration of one table's delete inside its own transaction, and puts it back before returning;
-- the transaction is atomic, so a failure leaves nothing half done and nothing unprotected.
CREATE FUNCTION app.demo_reset(p_tenant uuid)
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

  RETURN jsonb_build_object('lastSeq', v_last_seq, 'lastHash', v_last_hash, 'deleted', v_deleted);
END
$$;
--> statement-breakpoint
-- Functions of the schema "app" are executable by the application role by default (migration 0000).
-- This one is not: only the operator console may reset a demo organization.
REVOKE ALL ON FUNCTION app.demo_reset(uuid) FROM PUBLIC, app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.demo_reset(uuid) TO app_operator;
--> statement-breakpoint
-- The append-only guard of the audit trail (migration 0004) with one narrow exception: a DELETE
-- by the migration owner, inside app.demo_reset, for the organization named by `app.demo_reset`
-- and only while that organization is flagged as a demo one. The platform trail (which has no
-- tenant) and every other caller keep the absolute rule.
CREATE OR REPLACE FUNCTION app.audit_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF (to_jsonb(OLD) ? 'tenant_id')
         AND current_user = 'app_owner'
         AND current_setting('app.demo_reset', true) = (to_jsonb(OLD) ->> 'tenant_id')
         AND EXISTS (SELECT 1 FROM public.tenant t WHERE t.id::text = (to_jsonb(OLD) ->> 'tenant_id') AND t.is_demo) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'audit_event is append-only: rows cannot be deleted';
    END IF;
    IF current_user <> 'audit_sealer' THEN
      RAISE EXCEPTION 'audit_event is append-only: rows cannot be updated';
    END IF;
    IF OLD.seq IS NOT NULL OR OLD.prev_hash IS NOT NULL OR OLD.hash IS NOT NULL THEN
      RAISE EXCEPTION 'audit_event row is already sealed';
    END IF;
    IF NEW.seq IS NULL OR NEW.prev_hash IS NULL OR NEW.hash IS NULL THEN
      RAISE EXCEPTION 'audit_event seal must set seq, prev_hash and hash together';
    END IF;
    IF (to_jsonb(NEW) - 'seq' - 'prev_hash' - 'hash') IS DISTINCT FROM (to_jsonb(OLD) - 'seq' - 'prev_hash' - 'hash') THEN
      RAISE EXCEPTION 'audit_event seal may only fill seq, prev_hash and hash';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
-- Tenant data is deactivated, ended or revoked, never deleted (tenancy, "No deletion"). Earlier
-- migrations revoked DELETE from the tables with a clinical or legal weight; these were left with
-- the default grant although nothing deletes from them. Only the ephemeral tables keep it: login
-- challenges, sessions, action tokens, recovery codes and job markers expire or are replaced.
REVOKE DELETE, TRUNCATE ON "location", "professional", "professional_hours", "membership_location", "permission_grant", "tenant_feature", "tenant" FROM app_rw;
