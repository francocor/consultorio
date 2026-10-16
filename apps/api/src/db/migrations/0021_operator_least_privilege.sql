-- Two privileges of the operator console role that reached further than the console needs (Stage 1
-- security review, finding 7).
--
-- 1. tenant_key: the operator received INSERT for any organization, with no policy, so it could
--    plant a data key in an organization that already has members (the key service would then
--    protect new data with a key the operator chose). It creates the FIRST key of a NEW
--    organization and nothing else: version 1, active, only while nobody has joined. The unique
--    constraint on (tenant, purpose, version) already refuses a second version 1.
--
-- 2. professional: the operator could read every column of every professional of every
--    organization without a support grant. Verifying a registration needs the registration, not
--    the rest of the profile, so SELECT is limited to the columns of the verification.
CREATE POLICY "operator_first_key_only" ON "tenant_key" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK (
    "version" = 1
    AND "purpose" = 'tenant-dek'
    AND "status" = 'active'
    AND app.tenant_is_unclaimed("tenant_id")
  );
--> statement-breakpoint
REVOKE SELECT ON "professional" FROM app_operator;
--> statement-breakpoint
GRANT SELECT ("id", "tenant_id", "membership_id", "status", "matricula", "matricula_jurisdiction", "matricula_status", "verified_by_operator", "verified_at", "created_at", "updated_at")
  ON "professional" TO app_operator;
