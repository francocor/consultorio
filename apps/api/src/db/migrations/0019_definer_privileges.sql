-- Who may run each SECURITY DEFINER function (Stage 1 security review, finding 4).
--
-- A definer function runs with the rights of its owner, which owns every table, so who may call it
-- is part of the security model. Two things made that an accident instead of a decision:
--   * a new function is executable by PUBLIC unless someone remembers to revoke it, and
--   * migration 0000 gave app_rw EXECUTE on every function created in schema app from then on.
-- Together they left set_patient_safety_flags and ensure_audit_partitions open to PUBLIC (so also
-- to the operator console role and the audit sealer), and the operator-only helpers open to the
-- runtime role.
--
-- From now on a function created by the migration role is executable by nobody else until its own
-- migration grants it. A policy test (test/integration/definer-functions.test.ts) lists every
-- definer function, who may run it and why, and fails when a new one is not listed.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM app_rw;
--> statement-breakpoint
-- Written by the runtime role right after a professional saves an anamnesis: nobody else.
REVOKE ALL ON FUNCTION app.set_patient_safety_flags(uuid, uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_patient_safety_flags(uuid, uuid, text[]) TO app_rw;
--> statement-breakpoint
-- Called by the worker (runtime role) to create the next audit partitions: nobody else. Its search
-- path also gets the explicit pg_catalog first and pg_temp last that every other definer has.
REVOKE ALL ON FUNCTION app.ensure_audit_partitions(integer, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ensure_audit_partitions(integer, date) TO app_rw;
--> statement-breakpoint
ALTER FUNCTION app.ensure_audit_partitions(integer, date) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
-- The support grant and unclaimed-organization helpers serve the operator console's policies only.
-- They were revoked from PUBLIC in 0017 but the default privileges still handed them to app_rw.
REVOKE ALL ON FUNCTION app.active_support_grant(uuid) FROM app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.active_support_grant_id(uuid) FROM app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_is_unclaimed(uuid) FROM app_rw;
