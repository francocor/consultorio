-- Audit integrity enforced by the database (Stage 1 security review, finding 5).
--
-- 1. The sealer is a login of its own. Until now app_rw was a member of audit_sealer with SET, so
--    anyone who could run SQL as the API (an injection, a stolen runtime credential) could
--    `SET ROLE audit_sealer`, read the whole platform trail, and rewrite the seal columns of any
--    unsealed event. The worker now connects as audit_sealer (AUDIT_SEALER_DATABASE_URL); neither
--    app_rw nor app_operator can become it.
--
-- 2. A sealed row can come only from the sealer. app_rw and app_operator can INSERT audit events
--    and nothing stopped them from supplying `seq`, `prev_hash` and `hash` themselves; a sequence
--    number near the end of the bigint range stops the sealer for that organization for good.
--    A BEFORE INSERT trigger now refuses any seal column unless the current user is audit_sealer
--    (which has no INSERT privilege anyway: the check does not depend on that).

-- The membership was created by the cluster bootstrap GRANTED BY app_owner, precisely so that it
-- can be revoked here. An older database whose membership was granted by a superuser needs one
-- manual step, and the migration says which.
DO $$
DECLARE
  member_role text;
BEGIN
  FOREACH member_role IN ARRAY ARRAY['app_rw', 'app_operator'] LOOP
    IF pg_has_role(member_role, 'audit_sealer', 'MEMBER') THEN
      BEGIN
        EXECUTE format('REVOKE audit_sealer FROM %I', member_role);
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
      IF pg_has_role(member_role, 'audit_sealer', 'MEMBER') THEN
        RAISE EXCEPTION '% is still a member of audit_sealer and app_owner cannot revoke it. As a superuser run: REVOKE audit_sealer FROM %; and make audit_sealer a login role used only by the worker (infra/postgres/init/01-roles.sql). Local databases: pnpm infra:reset.', member_role, member_role;
      END IF;
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app.audit_event_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (NEW.seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL)
       AND current_user <> 'audit_sealer' THEN
      RAISE EXCEPTION 'audit seal columns (seq, prev_hash, hash) are written by the sealer, never on INSERT'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_insert_guard
  BEFORE INSERT ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_insert_guard();
--> statement-breakpoint
CREATE TRIGGER platform_audit_event_insert_guard
  BEFORE INSERT ON "platform_audit_event"
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_insert_guard();
