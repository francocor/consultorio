-- Judgment Day, Stage 2, round 1, finding C9: the self-added professional role closes for the
-- organizations that are already running.
--
-- An owner can add the professional role to themselves only while the setup wizard is not finished
-- (D21). An organization with no onboarding_state row, or one whose wizard was never completed,
-- kept that door open for ever. Here the wizard is marked finished for every real (non-demo)
-- organization that already has staff or a professional, attributed to its oldest owner. A sole
-- owner who has not started is left alone: the application closes the door 30 days after the
-- organization was created, wizard or not.
--
-- A migration has no tenant context, so row level security is lifted on the three tables for the
-- length of this transaction (see migrations 0030 and 0033).
ALTER TABLE "tenant" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "onboarding_state" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "onboarding_state" (tenant_id, wizard_completed_at, wizard_completed_by)
  SELECT t.id, now(), (
           SELECT m.user_id FROM "membership" m
            WHERE m.tenant_id = t.id
            ORDER BY (m.status = 'active') DESC, ('owner' = ANY (m.roles)) DESC, m.created_at, m.id
            LIMIT 1)
    FROM "tenant" t
   WHERE NOT t.is_demo
     AND (
       (SELECT count(*) FROM "membership" m WHERE m.tenant_id = t.id AND m.status = 'active') > 1
       OR EXISTS (
         SELECT 1 FROM "membership" m
          WHERE m.tenant_id = t.id AND m.status = 'active' AND 'professional' = ANY (m.roles))
     )
ON CONFLICT (tenant_id) DO UPDATE
   SET wizard_completed_at = EXCLUDED.wizard_completed_at,
       wizard_completed_by = EXCLUDED.wizard_completed_by,
       updated_at = now()
 WHERE "onboarding_state".wizard_completed_at IS NULL;
--> statement-breakpoint
ALTER TABLE "onboarding_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
