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
-- and one login only the worker uses:
--   audit_sealer  the only role allowed to fill the hash-chain columns of the audit trails (the
--                 tenants' and the platform's). The worker connects as it (AUDIT_SEALER_DATABASE_URL)
--                 to seal and to verify. The API process never has this login, and neither app_rw
--                 nor app_operator can switch to it (security review, finding 5).
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
    CREATE ROLE audit_sealer LOGIN PASSWORD 'audit_sealer_dev_only'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;
  -- Migration 0004 (already applied in existing databases, so it cannot be edited) still checks
  -- that app_rw is a member of audit_sealer. The membership is therefore created here, GRANTED BY
  -- app_owner, so that migration 0020 can revoke it: a membership granted by the superuser could
  -- only be revoked by a superuser. After the migrations app_rw is NOT a member.
  GRANT audit_sealer TO app_owner WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;
  GRANT audit_sealer TO app_rw WITH INHERIT FALSE, SET TRUE GRANTED BY app_owner;

  -- The owner needs to create extensions and schemas in this database.
  EXECUTE format('ALTER DATABASE %I OWNER TO app_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_rw, app_operator, audit_sealer', current_database());
END
$$;
