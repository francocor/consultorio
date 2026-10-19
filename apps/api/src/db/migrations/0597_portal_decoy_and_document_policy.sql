-- Judgment day, Stage 5, round 2 (JD-S5 R2).
--
-- R2-1  A challenge written for an address that must not receive a code (the decoy of the portal) has
--       a purpose of its own, `portal_decoy`. The check of the code and the count of the sends of an
--       address read the purposes they serve, so a decoy can neither end the live code of the person
--       whose address it names nor use up their three sends an hour. The hourly purge of the booking
--       (`booking.purge`) removes every challenge an hour after it expired, decoys included.
-- R2-5  `document`: the nil user (the system, and the portal, which has no user of its own) was let
--       through by the classification policy. The portal marks its transactions (`app.actor_kind`) and
--       reads shared documents only through the definer functions bound to its link.
-- R2-S  `app.demo_outbox_purge(NULL)` purged every row older than an hour (LEAST ignores NULL); the
--       function is STRICT now, so a NULL cutoff does nothing.
ALTER TABLE "otp_challenge" DROP CONSTRAINT "otp_challenge_purpose_check";--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_purpose_check" CHECK ("otp_challenge"."purpose" in ('booking', 'waitlist_join', 'portal_registration', 'portal_sign_in', 'portal_decoy'));
--> statement-breakpoint
ALTER POLICY "document_classification" ON "document" USING (
  "classification" = 'administrative'
  OR (
    current_setting('app.user_id', true) = '00000000-0000-0000-0000-000000000000'
    AND coalesce(current_setting('app.actor_kind', true), '') <> 'portal'
  )
  OR current_user = 'app_owner'
  OR (
    nullif(current_setting('app.professional_id', true), '') IS NOT NULL
    AND app.clinical_readable("patient_id", "author_professional_id", 'default', NULL::text)
  )
);
--> statement-breakpoint
ALTER FUNCTION app.demo_outbox_purge(timestamp with time zone) STRICT;
