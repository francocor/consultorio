-- Host resolution finds a tenant by slug BEFORE any tenant context exists. The tenant table is
-- isolated by its own id, so a second permissive policy lets one transaction read the single row
-- whose slug it declares in app.lookup_slug (transaction-local, set by the lookup query only).
-- Policies are OR-ed: with the setting unset the extra policy matches nothing, so every other
-- query is exactly as isolated as before.
CREATE POLICY "tenant_host_lookup" ON "tenant" FOR SELECT
  USING ("slug" = nullif(current_setting('app.lookup_slug', true), ''));
