-- Cluster bootstrap, run once by a superuser on a fresh database
-- (docker-entrypoint-initdb.d locally, a Testcontainers setup step in tests).
--
-- Two login roles with different powers:
--   app_owner  owns the schema objects and runs migrations.
--   app_rw     is what the API and worker connect as. It does NOT own any table, so
--              FORCE ROW LEVEL SECURITY applies to it, and it has no BYPASSRLS.
--
-- a third login role for the platform operator console:
--   app_operator  what the operator console connects as. It may touch the tenant row, the platform
--                 tables and a few administrative tables of a tenant, and NO clinical or patient
--                 table. Its privileges are granted by the migrations of the operator console.
--
-- and one role nobody logs in as:
--   audit_sealer  the only role allowed to fill the hash-chain columns of audit_event. The
--                 sealer job switches to it with SET LOCAL ROLE. app_rw may SET it but does not
--                 inherit its privileges, so ordinary queries never run with them.
--
-- The passwords below are for local development and tests ONLY. Production roles are provisioned
-- by the infrastructure with managed secrets and are never created from this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner LOGIN PASSWORD 'app_owner_dev_only'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN PASSWORD 'app_rw_dev_only'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_operator') THEN
    CREATE ROLE app_operator LOGIN PASSWORD 'app_operator_dev_only'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_sealer') THEN
    CREATE ROLE audit_sealer NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;
  GRANT audit_sealer TO app_rw WITH INHERIT FALSE, SET TRUE;

  -- The owner needs to create extensions and schemas in this database.
  EXECUTE format('ALTER DATABASE %I OWNER TO app_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_rw, app_operator', current_database());
END
$$;
