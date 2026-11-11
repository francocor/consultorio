# Apply progress: Stage 2 scheduling backend, review fixes

Change: `health-practice-saas`. Mode: **Strict TDD** (`strict_tdd: true`). Artifact store: openspec.
Branch `fix/stage-2-scheduling-review`, based on `28ba4cf` (the scheduling backend tip of
`feat/stage-2-practice-core`), developed in the isolated worktree `consultorio-wt-schedfix`. This file
is separate from `apply-progress.md` on purpose; the orchestrator merges the two.

Input: the fresh-context review of `9bd2379..28ba4cf` (verdict: fix first, no CRITICAL). Findings 1
(HIGH), 2 to 7 (MEDIUM) and 8 to 14 (LOW) are all fixed; none was accepted as is.

## Findings and where they were fixed

| # | Finding | Commit | Tests that prove it |
|---|---|---|---|
| 1 | Re-laning only saw direct overlaps (false `slot_taken`) | `857525d` | `book-appointment.test.ts` "re-laning along a chain of occupancies" (depth 2, depth 3, nothing to move, both lanes taken) and "an overlap the database refuses after the checks"; `lifecycle.test.ts` / `holds.test.ts` "answers an overlap the database refuses with the conflict and the next free slots"; integration `scheduling-races.test.ts` "re-lanes a chain of occupancies that only touch the new range (depth 2)" |
| 4 | Fresh-patient check evaluated per series session | `7e35f15` | `series.test.ts` "a series for a patient registered a moment ago (D14)" (3 sessions confirmed, no review; existing patient keeps 3 reviews) |
| 7 | Stale identity reviews on cancel / confirm of a cancelled appointment | `6d67c17`, `703ae17` (integration) | `lifecycle.test.ts` "dismisses the open identity review...", "...the pending approval item...", "closes nothing when the appointment is not cancelled"; `identity.test.ts` "refuses a cancelled appointment", "has nothing to reject on a cancelled appointment", "closes the review once when it cancels"; integration `scheduling-identity.test.ts` "a cancelled appointment leaves the identity review" |
| 2 | `expectedVersion` optional | `703ae17` | `packages/contracts/src/scheduling.test.ts` "need the version on a plain transition" and "...on every other write of an appointment"; `lifecycle.test.ts` / `identity.test.ts` "refuses a change that names no version"; the integration suites send the version through `world.act` |
| 6 | Multi-role location scope | `7ca0f2e` | `platform/authz/location-scope.test.ts` (11 cases); `scope.test.ts` "a reception user who is also a professional" (4); integration `scheduling-scope.test.ts` "a reception user who is also a professional" (reads, changes, booking, feed, availability) |
| 3 | Calendar truncation is silent | `2f9799e` | contracts `CalendarResponse` test; integration `scheduling-calendar.test.ts` "says the answer is complete when it is, and cut short when the cap is reached" (cap 10, 3 and 2 over 3 appointments) |
| 5 | Delegated views not audited | `95a0c9e` | integration `scheduling-calendar.test.ts` "looking at one appointment, its history or free time in a delegated calendar" (audited once per look; not own calendar, not reception/admin; not when refused) |
| 8 | `correct` into `in_progress` / `attended` by reception | `dac10d0` | `lifecycle.test.ts` "needs the appointment's own professional to correct into attended / in_progress" (reception, colleague, admin), "leaves the corrections that are not clinical to whoever may check in"; integration `scheduling-lifecycle.test.ts` "is clinical work when it goes into attended or in progress" |
| 11 | Free-text correction reason in the audit trail | `dac10d0` | `lifecycle.test.ts` "keeps the free text out of the audit trail and in the history only"; contracts `CorrectStatusRequest` test; integration audit + history assertions |
| 9 | `overrideHold` needed only `scheduling.book` | `8fd1ca3` | `book-appointment.test.ts` "refuses the override to a user without the permission, and leaves the hold alone" (and "does not invalidate a hold that is not in the way": the permission is asked for only when used); contracts `roles.test.ts`; integration `scheduling-holds.test.ts` "refuses the override to reception until it is granted" |
| 10 | Cancel is `patient_protective` for every `cancelledBy` | `fd996be` | `platform/read-only/index.test.ts` "a route that is open to the patient and closed to the organization"; integration `scheduling-scope.test.ts` "lets only a cancellation the patient asked for through" (organization 402, professional 402, patient 200) |
| 12 | `releaseOldestHolds` without a status guard | `439353a` | integration `scheduling-holds.test.ts` "does not release a hold that was converted while it was deciding" (two transactions; failed before the fix with `released`) |
| 13 | `recompute_care_relationship` lock order | `6e19bbc` | integration `scheduling-care-locks.test.ts` "takes the locks of the two pairs of a reassignment in key order" (failed before the fix: the waiting session held no lower key) and "still counts the old and the new pair" |
| 14 | Missing race tests | `857525d` | integration `scheduling-races.test.ts`: 3 simultaneous bookings against capacity 2 (201, 201, 409 with the full extension; lanes 1 and 2), a hold against a booking of the same range, two reschedules to the same range |

## Contract changes (for the UI agent)

Announced:

- `expectedVersion` is **required** on `TransitionRequest` (confirm, start, attend, no-show, approve), `CheckInRequest`, `CancelAppointmentRequest`, `CorrectStatusRequest`, `ConfirmIdentityRequest` and both branches of `DetachPatientRequest` (it already was on `RescheduleRequest`). A missing or different value answers 409 `stale_revision` at the use-case level too.
- `CalendarResponse.truncated: boolean`. True when the window holds more than one answer carries (cap 2000, earliest kept); the screen should ask to narrow the filter.
- 409 `slot_taken` **always** carries `SlotConflictExtension` (`conflict`, `nextSlots`). The bare fallback in the routes is gone; every database refusal of an overlap becomes a `SlotTakenError` in the use cases.
- A correction into `in_progress` or `attended` requires the appointment's professional (403 `forbidden`, audited as `not_the_appointment_professional`).

Not announced, forced by the findings (the UI agent has to know):

- `CorrectStatusRequest` is now `{ toStatus, reasonCode, note?, expectedVersion }` with `reasonCode` one of `entered_by_mistake`, `patient_arrived_late`, `recorded_late`, `other` (`CORRECTION_REASONS`); the free-text `reason` is gone (finding 11). The note is kept in the appointment history only.
- `WorklistAppointmentDto.version` (additive): the worklist actions (confirm the identity, detach the patient) need the version they must send.
- New grantable permission `scheduling.override_hold` (finding 9): `overrideHold: true` on a booking or a reschedule is a 403 for anyone who lacks it when a hold is really in the way. Owner and admin have it by default; reception and professional need a grant. Spanish label added to `staff.json`.
- `POST /appointments/:id/cancel` with `cancelledBy` other than `patient` is a 402 `tenant_read_only` on a read-only organization.
- GET `/appointments/:id`, `/history` and `/availability` write `appointment.calendar_viewed` for a delegated look (no contract change).

## Migrations

- `apps/api/src/db/migrations/0080_care_lock_order.sql` (journal idx 28, snapshot `0080_snapshot.json`, a copy of 0027 with new ids). The orchestrator renumbers it at merge. It adds `app.care_lock_key` (plain SQL function, `search_path = pg_catalog, pg_temp`, EXECUTE revoked from PUBLIC and `app_rw`), and redefines `app.recompute_care_relationship` and `app.appointment_care_sync` (both stay SECURITY DEFINER with `search_path ... pg_temp` and no PUBLIC or `app_rw` execute). The definer allowlist (`definer-functions.test.ts`) needed no new entry because `care_lock_key` is not a definer function.

## Strict TDD evidence

| Finding | Test file(s) | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|
| 1 | `book-appointment.test.ts`, `lifecycle.test.ts`, `holds.test.ts`, `scheduling-races.test.ts` | Unit + integration | 2 chain tests failed (relane saw only direct overlaps); 3 refused-overlap tests failed (booking, correction, hold) | passed after `occupanciesAround` and `guardRace` | depth 2, depth 3, no-move, infeasible | `applyPlan(ports, input, plan)` and `db-errors.ts` extracted |
| 4 | `series.test.ts` | Unit | failed (`identityConfirmed` false on session 2) | passed | existing-patient case | none needed |
| 7 | `lifecycle.test.ts`, `identity.test.ts`, integration | Unit + integration | 4 failed | passed | cancel / pending approval / no close on confirm / detach | none needed |
| 2 | contracts, `lifecycle.test.ts`, `identity.test.ts` | Unit | 2 + 2 failed | passed | each request type | `world.act` helper |
| 6 | `location-scope.test.ts`, `scope.test.ts`, integration | Unit + integration | module missing; 1 unit test and 3 integration tests failed | passed | own calendar, other calendar, feed, availability | `locationAccessOf` shared by calendar, routes, availability |
| 3 | contracts, integration | Unit + integration | contracts test failed | passed | cap above, at and below the count | none needed |
| 5 | integration | Integration | failed (`[2,2,2]` instead of `[3,4,5]`) | passed | own calendar, reception, admin, refused | `delegated-view.ts` |
| 8, 11 | `lifecycle.test.ts`, contracts, integration | Unit + integration | written first against code that could not satisfy them (`CorrectionReason` and `reasonCode` did not exist, so the unit and contract tests failed to compile or parse); the run before the implementation was not executed | passed | attended and in progress; reception, colleague, admin; non clinical correction | none needed |
| 9 | `book-appointment.test.ts`, contracts, integration | Unit + integration | failed (no permission asked for) | passed | override used and not used | none needed |
| 10 | `read-only/index.test.ts`, integration | Unit + integration | failed (helper missing) | passed | patient, organization, professional; active, read-only, cancelled | none needed |
| 12 | integration | Integration | failed (`released` over `converted`) | passed | normal release still works | none needed |
| 13 | integration | Integration | failed (low key not held while waiting) | passed | counters after a reassignment | `care_lock_key` shared |

## Decisions and deviations

1. Finding 6 reading: a user who is only a professional is still held to calendars, not to locations (their delegated colleagues' calendars stay open at every location, as before). The fix targets the escalation: reception, with or without the professional role, is limited to its assigned locations in every calendar but its own. The spec line "professionals MUST have access to the locations where they practice" is not narrowed.
2. Finding 11: the note is stored in the appointment event details (history), not in the audit trail; the code is in both.
3. Finding 9: a new grantable permission instead of reusing `scheduling.override_hours`. `openspec/.../design.md` (grantable toggles table) and the authorization spec still list five grantable permissions; they are not edited here.
4. Finding 7: a reschedule keeps the identity review open (the appointment is alive). A reschedule that changes the location does not move the item's `location_id`; not in the findings, noted as a risk.
5. The routes lost their bare `slot_taken` fallback for `23P01`. Every write that can raise it (`applyLaneMoves`, `updateAppointment`, `insertHold`, `insertAppointment`) is converted in the use case and runs in a savepoint, so the transaction can still read the next free slots after the refusal.
6. Working tree accident, fixed before pushing: a `prettier --write src` reformatted the drizzle snapshots and was committed; the history was rewritten (nothing was pushed) so the branch touches no existing snapshot.

## Verification

Run on the tip of `fix/stage-2-scheduling-review` (Node 24, pnpm 10.34.7 through corepack, Docker with Testcontainers Postgres 17):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 (contracts, web, api) |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0 |
| `pnpm test` | exit 0, 166 files, 2193 tests |
| `pnpm test:integration` | exit 0, 92 files, 1406 tests |
| `pnpm build` | exit 0 |
| `pnpm db:check` | exit 0, no migration drift |

Notes:

- The Docker host is shared with other worktrees and slow on fsync (`WalSync` waits). Several runs failed on infrastructure before reaching an assertion (container health check or port binding timed out), and one full integration run was stopped by hand after it stalled behind other workloads; each was re-run and the final full run is the one above.
- `apps/web` was touched only for the label and the test list of the new grantable permission (`locales/es-AR/staff.json`, `features/staff/staff.test.tsx`). Nothing under `apps/web` uses the changed contracts yet.
