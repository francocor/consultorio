-- Foundation: privilege model, helper schema and extensions.
-- Runs as app_owner. The roles themselves are created by the cluster bootstrap
-- (infra/postgres/init/01-roles.sql); this migration only verifies and grants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    RAISE EXCEPTION 'role app_rw is missing; run infra/postgres/init/01-roles.sql first';
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'app_rw' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'role app_rw must not be superuser, BYPASSRLS, CREATEROLE or CREATEDB';
  END IF;
END
$$;
--> statement-breakpoint
-- Helper functions (RLS predicates, sealing, partition management) live in schema "app".
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
-- Nobody but the owner can create objects in public; the runtime role can only use them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_rw;
--> statement-breakpoint
-- Everything app_owner creates from now on is usable by app_rw. RLS, not table grants, is what
-- separates tenants, so tables that need narrower rights (audit_event) REVOKE explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO app_rw;
