# Apply progress: Stage 3, track C (waitlist, S3.11 to S3.13 and task 3.61)

Change: `health-practice-saas`. Branch `feat/stage-3-track-3c`, from `04048ea` (tracks A, B and D already integrated). Mode: automatic, strict TDD, `size:exception` (work-unit commits, no PR, no merge, CI not polled). This file is separate from `apply-progress.md` on purpose; the orchestrator merges it.

## Status of the tasks

| Task | State | Notes                                                                                                                                                                                   |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.51 | done  | `waitlist_entry`, `waitlist_offer`, `waitlist_call` and migration `0360`; contracts in `packages/contracts/src/waitlist.ts`.                                                            |
| 3.52 | done  | Entries with preferences, expiry and manual contact: `POST\|GET\|PATCH /waitlist`, pause, resume, close, priority override (audited).                                                    |
| 3.53 | done  | Pure `domain/matching.ts` (eligibility, ordering with priority 0/1/2, offer window), `domain/manual-contact.ts`.                                                                        |
| 3.54 | done  | `slot_freed` trigger, `waitlist.match` job, offers invalidated when a slot is taken.                                                                                                    |
| 3.55 | done  | Offer delivery through the port, quiet-hours deferral, exact expiry plus a 60 s sweep, `consecutive_expired` >= 3 flags the entry (exposed as `unresponsive`).                           |
| 3.56 | done  | `waitlist_offer` token page (accept and decline) on track A's token router; capacity-1 booking through `bookAppointment`; accept races resolved by lock order professional, offers, entries. |
| 3.57 | done  | Public self-join: `booking_submission(kind=waitlist_join)` + `otp_challenge`, code by email, non-disclosing identical answers, bot challenge, rate limits.                             |
| 3.58 | done  | Opt-out (offers are opt-in, D10), fairness, read-only tenant, audit and the outcomes kept for the reports.                                                                              |
| 3.59 | done  | `features/waitlist`: list with status and unresponsive filters, add, edit, pause, resume, close; close prompt in the appointment drawer slot.                                          |
| 3.60 | done  | Reception panel for the slots to fill by phone (`waitlist_call`) and the unresponsive list: API and UI.                                                                                 |
| 3.49 | done  | Completed here: `BookingFlow` passes `waitlistPath` to `SlotPicker` (the track B half was the manage page). |
| 3.61 | done  | Public join page `/book/$slug/p/$professionalSlug/waitlist` reached from `SlotPicker`'s `waitlistPath`; `apps/web/e2e/stage3-waitlist.spec.ts`.                                         |

## Commits (oldest first)

1. `484f6e2` entry and offer tables with their contracts (3.51)
2. `36c3b82` entries, preferences, expiry, manual contact, staff routes (3.52)
3. `87fe155` pure matching, ordering, priority, offer timing (3.53)
4. `9dc3cb6` slots reception can fill by phone in migration 0360 (3.51)
5. `6c37c74` match freed slots, invalidate offers for taken slots (3.54)
6. `022b795` deliver and expire offers, quiet hours, unanswered entries (3.55)
7. `e35d608` accept or decline from the link, booking once (3.56)
8. `216b41e` self-join verified by a code (3.57)
9. `144fe32` opt-out, fairness, read-only, outcomes (3.58)
10. `fa9e0f7` call list and unresponsive entries, API (3.60)
11. `70f6608` staff waitlist screen (3.59, 3.60)
12. `7b743cb` public join page and e2e spec (3.61)
13. `e007e5c` e2e: second time two hours after the first (3.61)
14. `5ff2d0e` waitlist errors and audit actions moved to `contracts/waitlist-catalog.ts`
15. `d56d5d4` quiet hours through the `OfferQuietHoursEnd` port (3.55)
16. `d72ce97` demo-coverage exemptions for the waitlist tables; waitlist link asserted on the booking page (3.49, 3.61)

## Migration

Only `apps/api/src/db/migrations/0360_waitlist.sql` (range 0360 to 0369), with its snapshot and journal entry in `meta`. Tables `waitlist_entry`, `waitlist_offer`, `waitlist_call` (tenant tables, RLS, REVOKEs appended, checks and partial unique indexes: one open offer per slot and per entry). `pnpm db:check` passes.

## The delivery port and what to connect at merge

The waitlist never imports the notifications module. It codes against

```ts
type DeliverWaitlistOffer = (
  tx: Tx,
  input: {
    offerId: string;
    patientId: string;
    professionalId: string;
    locationId: string;
    startsAt: Date;
    endsAt: Date;
    expiresAt: Date;
    offerTokenUrl: string;
  },
) => Promise<{ channel: 'whatsapp' | 'email' | 'none'; messageId: string | null }>;
```

(`modules/waitlist/application/ports.ts`). `createWaitlistJobs({ deliver })` takes it; tests use a fake (`test/support/waitlist-world.ts`). In the composition root (`apps/api/src/main/wiring/waitlist.ts`, worker slot) the stand-in `createEmailOfferDelivery({ email })` sends a plain email with the token link, so the e2e works without the notifications module. The line is marked `CONNECT AT MERGE`: replace it with the notifications module's `deliverWaitlistOffer`.

Quiet hours (notifications' `offerQuietHoursEnd(tx, { locationId, at }): Promise<Date | null>`): the waitlist models it as the optional port `OfferQuietHoursEnd` and the optional `quietHoursEnd` dep of `createWaitlistJobs` (`modules/waitlist/application/ports.ts`, `delivery.ts`). Before delivering, the job asks it; a date queues the same offer again for `startAfter` that date and sends nothing (`deferred`). A `none` that comes back while the port says "quiet hours" is also a deferral, not an unreachable patient (the entry is not made manual-contact-only). If quiet hours outlast the offer, the offer ends, reception sees the slot with reason `quiet_hours` and the next entry is matched. Connect at merge: pass `offerQuietHoursEnd` as `quietHoursEnd` in `main/wiring/waitlist.ts` (second marked line). Without it the waitlist relies on its own deferral at match time.

The offer link lives in notifications' `message_offer` (migration 0390); the waitlist keeps its own `waitlist_offer` token (`kind waitlist_offer`) and passes only `offerTokenUrl`.

Other merge notes:

- Demo coverage: `test/integration/demo-coverage-exemptions/waitlist.ts` lists the three tables until S3.16 seeds them and deletes the file.
- `WAITLIST_ERRORS` and `WAITLIST_AUDIT_ACTIONS` are in `packages/contracts/src/waitlist-catalog.ts` (imported by `errors.ts` and `audit-actions.ts`); `index.ts` exports both files.

- `platform/tokens/kinds.ts`: only `waitlist_offer` flipped to enabled.
- `platform/public/token-page.ts` gained `secondaryAction` and `action.value`; `token-router.ts` reads `choice` into `TokenContext.choice` (a decline button next to accept). Existing token pages are unaffected (tests extended).
- `features/patients/index.ts` is new and exports `PatientPicker` so the waitlist feature respects the feature-boundary lint.
- `features/public-booking/BookingFlow.tsx`: one line (`waitlistPath` passed to `SlotPicker`).
- `app/shell.test.tsx`: the reception nav assertion lists the sixth entry.

## Decisions and deviations

- The waitlist is a capacity-1 wrapper over scheduling's `bookAppointment` (source `waitlist_offer`); D14 self-join matches create an unconfirmed identity. A dry-run mode validates a candidate without writing.
- Lock order is professional, offers, entries (`offer-lock.ts`) after a deadlock between an accept and a staff booking showed up in the integration tests.
- Offer window is min(30 min, start minus lead 60 min) with at least 5 minutes of life; quiet hours defer the delivery (luxon).
- `unresponsive` is the name exposed to clients for `flagged_at` (the request-schema policy test rejects the word `flagged`).
- The consent message key is `waitlist.consent_required` (not the booking one), in the API, the web schema and the tests.
- Slots offered by phone live in their own table (`waitlist_call`) rather than the reception worklist port, to keep the state (called, no answer, filled) per slot.
- The e2e org sets `minLeadHours` 336 and `horizonDays` 1 for online booking so no time is free for visitors, while staff still book three days ahead.

## TDD evidence

Every slice began with failing tests: contracts (`waitlist.test.ts`), pure matching (`matching.test.ts`, triangulated with priority and fairness cases), the integration suites `waitlist-{schema,entries,matching,offers,offer-link,join,fairness,calls}.test.ts` on Testcontainers, the wiring test, the platform token page and router tests, and the web suites (`waitlist-page.test.tsx` 24, `slots.test.tsx` 10, `preferences.test.ts`, `waitlist-join.test.tsx` 12). The audit scenarios (`test/policy/audit-scenarios/waitlist.ts`) map every waitlist action.

## Verification (final tip)

| Check                                        | Result                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`    | ok                                                                |
| `typecheck`                                  | ok (contracts, web, api)                                          |
| `lint`                                       | ok                                                                |
| `format:check`                               | ok                                                                |
| `test`                                       | 310 files, 3905 tests passed                                      |
| `test:integration`                           | 164 files passed (1 skipped), 2553 tests passed                   |
| `build`, `db:check`                          | ok, no migration drift                                            |
| `test:e2e` (whole suite, `--workers=3`)      | 182 passed, including `stage3-waitlist.spec.ts` (ports 4620, 3620, 9620) |

## Risks

- Until `deliverWaitlistOffer` is connected, offers go out as plain email only (no WhatsApp).
- Running two integration processes at once made `backup-restore.test.ts` flaky (socket hang up); it passes alone and in the sequential full run.
- The e2e stack leaves its containers behind when playwright ends on this machine; remove them by port before a rerun.
