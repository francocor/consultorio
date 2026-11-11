-- Judgment day, Stage 6, round 1 (JD-S6 R1, A-S): 0618 replaced the check of the kinds of
-- `subscription_notice` and left it NOT VALID, which only `runMigrations` ever validated (a database
-- built by the migrator alone kept it unvalidated for good, so the planner could not trust it and a
-- row written before it was never checked). The table is a small log of emails owed to the owners, so
-- validating it inside the migrator's transaction is harmless here; it is a no-op where the runner
-- already validated it.
ALTER TABLE "subscription_notice" VALIDATE CONSTRAINT "subscription_notice_kind_check";
