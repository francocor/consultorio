-- Stage 6, judgment day round 2 (JD-S6 R2-2): the four eyes of the break-glass release cannot be
-- bypassed by rewriting who took a step.
--
-- 0686 bound each step to the operator of the session, but only when the status CHANGED and only for the
-- column of the step being taken. A same-status UPDATE returned early, so `*_by` could be rewritten, and
-- an approval could overwrite `identity_verified_by` in the same statement. For the operator role, on
-- EVERY update now:
--   - `recorded_by` never changes;
--   - `identity_verified_by` / `identity_verified_at` change only in requested -> identity_verified;
--   - `approved_by` / `approved_at` change only in identity_verified -> approved;
--   - `rejected_by` changes only in a move to rejected.
-- A same-status update therefore cannot touch any of them. On INSERT the recorder is the operator of the
-- session (`app.user_id`), not whoever the statement names.
--
-- The people: the approver is neither the recorder (check, validated below) nor the verifier (0654). The
-- recorder MAY be the verifier: the runbook has A record and verify the identity and B approve.
--
-- `app.user_id` is set by the application from the operator's session. This protects against bugs and
-- misuse of the console; it does not protect against a hostile database credential, which can set the
-- setting to anything (docs/runbooks/archive-release.md).
CREATE OR REPLACE FUNCTION app.archive_release_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_verify boolean := OLD.status = 'requested' AND NEW.status = 'identity_verified';
    v_approve boolean := OLD.status = 'identity_verified' AND NEW.status = 'approved';
    v_reject boolean := OLD.status IN ('requested', 'identity_verified', 'approved') AND NEW.status = 'rejected';
  BEGIN
    IF current_user = 'app_operator' THEN
      IF NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
         OR (NOT v_verify AND (NEW.identity_verified_by IS DISTINCT FROM OLD.identity_verified_by
                               OR NEW.identity_verified_at IS DISTINCT FROM OLD.identity_verified_at))
         OR (NOT v_approve AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
                                OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
         OR (NOT v_reject AND NEW.rejected_by IS DISTINCT FROM OLD.rejected_by) THEN
        RAISE EXCEPTION 'who took a step of a release request does not change' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.status = OLD.status OR current_user NOT IN ('app_operator', 'app_rw', 'app_releaser') THEN
      RETURN NEW;
    END IF;
    IF current_user = 'app_operator' AND v_actor IS NOT NULL THEN
      IF v_verify AND NEW.identity_verified_by = v_actor
         AND OLD.created_at > now() - interval '7 days' THEN
        RETURN NEW;
      END IF;
      IF v_approve AND NEW.approved_by = v_actor
         AND OLD.created_at > now() - interval '7 days' THEN
        RETURN NEW;
      END IF;
      IF v_reject AND NEW.rejected_by = v_actor THEN
        RETURN NEW;
      END IF;
    END IF;
    IF current_user = 'app_releaser' AND (
         (OLD.status = 'approved' AND NEW.status IN ('released', 'expired', 'failed'))
      OR (OLD.status = 'released' AND NEW.status = 'failed')
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a release request cannot go from % to % for this role', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
CREATE FUNCTION app.archive_release_recorder() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF current_user = 'app_operator'
       AND NEW.recorded_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
      RAISE EXCEPTION 'a release request is recorded by the operator of the session' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER archive_release_request_recorder
  BEFORE INSERT ON "archive_release_request"
  FOR EACH ROW EXECUTE FUNCTION app.archive_release_recorder();
--> statement-breakpoint
ALTER TABLE "archive_release_request" VALIDATE CONSTRAINT "archive_release_request_recorder_check";
