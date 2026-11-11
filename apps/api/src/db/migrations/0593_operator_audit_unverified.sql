-- Judgment day, Stage 5, round 1 (JD-S5 R1, A-S): the owner reads in the organization's own trail that
-- a registration stopped being verified, next to the verification. Until now a withdrawal was in the
-- platform trail only (migration 0505).
DROP POLICY "operator_audit_scope" ON "audit_event";
--> statement-breakpoint
CREATE POLICY "operator_audit_scope" ON "audit_event" AS RESTRICTIVE FOR INSERT TO app_operator
  WITH CHECK ("action" IN ('tenant.created', 'support.access', 'matricula.verified', 'matricula.unverified'));
